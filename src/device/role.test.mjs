import assert from "node:assert/strict";
import test from "node:test";

import { ROLES, ROLE_ROWS, commandKeyOf, identifyingProcess, roleAt, roleOf } from "../../.preview/device/role.js";

/** A pane running nothing Herdr recognises as an agent. */
const plainPane = (overrides = {}) => ({ pane_id: "p1", workspace_id: "w1", agent_status: "unknown", ...overrides });

const process = (cmdline, overrides = {}) => ({ pid: 1, name: "x", argv0: cmdline.split(" ")[0], cmdline, ...overrides });

const detect = (cmdline, pane = plainPane()) => roleOf(pane, process(cmdline));

/**
 * The exact reply a running Herdr gave for the pane an agent was working in.
 * Two things about it would each have broken detection on their own.
 */
const recordedAgentPane = {
  pane_id: "w4:p1",
  shell_pid: 98322,
  foreground_process_group_id: 11907,
  foreground_processes: [
    {
      pid: 11919,
      name: "ebook-knowledge",
      argv0: "ebook-knowledge-mcp",
      argv: ["/Users/zein/.local/bin/ebook-knowledge-mcp"],
      cmdline: "/Users/zein/.local/bin/ebook-knowledge-mcp"
    },
    { pid: 11907, name: "2.1.233", argv0: "claude", argv: ["claude"], cmdline: "claude" }
  ]
};

/** And the reply for a pane sitting at a login shell. */
const recordedShellPane = {
  pane_id: "w4:p3",
  shell_pid: 36846,
  foreground_process_group_id: 36846,
  foreground_processes: [{ pid: 36846, name: "zsh", argv0: "zsh", argv: ["-zsh"], cmdline: "-zsh" }]
};

test("the identifying process leads the foreground group, and is not the first listed", () => {
  // The agent had spawned an MCP server, which Herdr lists first. Taking the
  // first entry would call this pane an ebook indexer.
  const identified = identifyingProcess(recordedAgentPane);
  assert.equal(identified.pid, recordedAgentPane.foreground_process_group_id);
  assert.equal(identified.argv0, "claude");
});

test("a pane with one process identifies by that process", () => {
  assert.equal(identifyingProcess(recordedShellPane).argv0, "zsh");
});

test("a pane Herdr told us nothing about identifies nothing, rather than throwing", () => {
  assert.equal(identifyingProcess(undefined), undefined);
  assert.equal(identifyingProcess({ pane_id: "p", foreground_processes: [] }), undefined);
});

test("a group leader Herdr did not name falls back to the process that spawned the rest", () => {
  // Children are listed before their parent, so the last entry is the fallback.
  const info = { pane_id: "p", foreground_processes: [process("child"), process("parent")] };
  assert.equal(identifyingProcess(info).cmdline, "parent");
});

test("an override is keyed on the command line, never on the process name", () => {
  // Claude reports its `name` as its version, so keying on name would tie an
  // override to a release and lose it on every update.
  const claude = identifyingProcess(recordedAgentPane);
  assert.equal(claude.name, "2.1.233");
  assert.equal(commandKeyOf(claude), "claude");
});

test("a pane with nothing running has no override key to remember it by", () => {
  assert.equal(commandKeyOf(undefined), undefined);
  assert.equal(commandKeyOf({ pid: 1, name: "x" }), undefined);
});

test("Herdr's own agent detection decides the agent row, with no pattern matching", () => {
  // Herdr pushes `agent` on the snapshot, so this needs no process lookup and
  // cannot be got wrong by a pattern.
  assert.equal(roleOf(plainPane({ agent: "claude" }), undefined), "agent");
  assert.equal(roleOf(plainPane({ agent: "codex" }), process("-zsh")), "agent");
});

test("a coding agent, a test watcher and a dev server are each detected with no configuration", () => {
  assert.equal(roleOf(plainPane({ agent: "claude" }), identifyingProcess(recordedAgentPane)), "agent");
  assert.equal(detect("vitest --watch"), "tests");
  assert.equal(detect("npm run dev"), "server");
});

test("a test watcher started through a package manager is not read as a dev server", () => {
  // These differ only in their script, and both begin the same way.
  assert.equal(detect("npm run test -- --watch"), "tests");
  assert.equal(detect("pnpm test"), "tests");
  assert.equal(detect("npm run dev"), "server");
  assert.equal(detect("pnpm run serve"), "server");
});

test("the common runners of each role are recognised", () => {
  for (const command of ["vitest", "jest --watch", "pytest -q", "cargo test", "go test ./...", "npx playwright test"]) {
    assert.equal(detect(command), "tests", command);
  }
  for (const command of ["vite", "next dev", "nodemon server.js", "uvicorn app:main", "cargo watch -x run", "rails s"]) {
    assert.equal(detect(command), "server", command);
  }
  for (const command of ["tail -f log/dev.log", "journalctl -f", "docker logs -f api", "kubectl logs -f pod"]) {
    assert.equal(detect(command), "logs", command);
  }
});

test("a program named inside an argument is not mistaken for the program", () => {
  // Searching the command line for "next" reads this as a dev server, which is
  // the kind of confidently wrong answer that teaches you to stop believing the
  // device. Program names match a whole token or not at all.
  assert.equal(detect("nvim next.config.js"), "shell");
  assert.equal(detect("vim src/server.ts"), "shell");
  assert.equal(detect("cat contest.txt"), "shell");
  assert.equal(detect("man test"), "shell");
  assert.equal(detect("git log --follow CHANGELOG.md"), "shell", "a log is not logs being followed");
});

test("a runner is stepped over to reach the program that matters", () => {
  assert.equal(detect("npx vitest"), "tests");
  assert.equal(detect("pnpm exec jest --watch"), "tests");
});

test("a subcommand is read across the line, because that is where its meaning is", () => {
  // `npm` alone says nothing; `npm run dev` says everything.
  assert.equal(detect("npm run test:watch"), "tests");
  assert.equal(detect("docker compose up"), "server");
  assert.equal(detect("docker-compose up -d"), "server");
  assert.equal(detect("docker ps"), "shell", "not every docker command is a server");
});

test("a login shell arrives with a leading dash and is still a shell", () => {
  assert.equal(roleOf(plainPane(), identifyingProcess(recordedShellPane)), "shell");
  for (const command of ["-zsh", "zsh", "bash", "-bash", "fish", "/bin/sh"]) {
    assert.equal(detect(command), "shell", command);
  }
});

test("something unrecognised is a shell, since that is what running things by hand is", () => {
  assert.equal(detect("psql herdr_dev"), "shell");
  assert.equal(roleOf(plainPane(), undefined), "shell");
});

test("an override beats both detection and Herdr's own answer", () => {
  const claude = identifyingProcess(recordedAgentPane);
  assert.equal(roleOf(plainPane({ agent: "claude" }), claude, { claude: "shell" }), "shell");
  assert.equal(roleOf(plainPane(), process("vitest"), { vitest: "logs" }), "logs");
});

test("an override naming a role this version does not have is ignored", () => {
  assert.equal(roleOf(plainPane(), process("vitest"), { vitest: "telepathy" }), "tests");
});

test("the rows cover every role exactly once", () => {
  assert.deepEqual(ROLE_ROWS.map((row) => [...row]), [["agent"], ["server"], ["tests", "logs", "shell"]]);
  assert.equal(new Set(ROLES).size, ROLES.length, "no role sits on two rows");
});

test("roleAt names the role a picker's row and column would show, the same position a channel's pane rows already use", () => {
  assert.equal(roleAt(0, 0), "agent");
  assert.equal(roleAt(1, 0), "server");
  assert.equal(roleAt(2, 0), "tests");
  assert.equal(roleAt(2, 1), "logs");
  assert.equal(roleAt(2, 2), "shell");
});

test("roleAt is null wherever a row has fewer roles than columns, or the row does not exist at all", () => {
  assert.equal(roleAt(0, 1), null, "agent's row has only one role");
  assert.equal(roleAt(0, 2), null);
  assert.equal(roleAt(1, 1), null, "server's row has only one role");
  assert.equal(roleAt(3, 0), null, "there is no fourth role row");
});
