$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$source = Join-Path $root "dev.herdr.streamdeck.sdPlugin"
$herdr = (Get-Command herdr -CommandType Application -ErrorAction Stop).Source
$output = Join-Path $root "dist"
$package = Join-Path $output "herdr-streamdeck.streamDeckPlugin"
$zip = "$package.zip"
$staging = Join-Path ([IO.Path]::GetTempPath()) "herdr-streamdeck-install-$([guid]::NewGuid())"
$stagedPlugin = Join-Path $staging "dev.herdr.streamdeck.sdPlugin"

if (-not (Test-Path (Join-Path $source "bin\plugin.js"))) {
    throw "The prebuilt Stream Deck plugin is missing."
}

New-Item -ItemType Directory -Force $output, $staging | Out-Null
try {
    Copy-Item $source $stagedPlugin -Recurse
    Copy-Item (Join-Path $root "LICENSE"), (Join-Path $root "THIRD_PARTY_NOTICES.md") $stagedPlugin
    Copy-Item (Join-Path $root "licenses") (Join-Path $stagedPlugin "licenses") -Recurse
    Remove-Item -LiteralPath (Join-Path $stagedPlugin "logs") -Recurse -Force -ErrorAction SilentlyContinue
    [IO.File]::WriteAllText(
        (Join-Path $stagedPlugin "herdr-path.txt"),
        $herdr,
        [Text.UTF8Encoding]::new($false)
    )
    Remove-Item -Force $package, $zip -ErrorAction SilentlyContinue
    Compress-Archive -Path $stagedPlugin -DestinationPath $zip -CompressionLevel Optimal
    Move-Item $zip $package

    # Herdr builds in a temporary checkout that it relocates as soon as this
    # script exits. Stream Deck opens packages asynchronously, so launch a
    # persistent cache copy rather than the soon-to-move build artifact.
    $installerCache = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Herdr\installers"
    $launchPackage = Join-Path $installerCache "herdr-streamdeck.streamDeckPlugin"
    New-Item -ItemType Directory -Force $installerCache | Out-Null
    Copy-Item -LiteralPath $package -Destination $launchPackage -Force
    Start-Process $launchPackage
    Write-Host "Opened the Stream Deck installer. Accept its install prompt to finish."
} finally {
    Remove-Item -LiteralPath $staging -Recurse -Force
}
