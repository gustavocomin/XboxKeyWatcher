param([switch]$WithClipboard, [switch]$Soak)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
& '.\.venv\Scripts\python.exe' -m unittest discover -s tests -p test_openai_vision_benchmark.py
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
# Channel bot: key announcements, hand-off to the app, OCR worker restart and refusals
# (the worker tests use tools\wa-listener\test-images from make-test-images.ps1; skipped without it).
node --test tools/wa-listener/tests/channel-signals.test.mjs tools/wa-listener/tests/app-inbox.test.mjs tools/wa-listener/tests/bot-ocr-worker.test.mjs tools/wa-listener/tests/key-alert.test.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
dotnet run --project tests\XboxKeyWatcher.Tests -c Release
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
dotnet run --project benchmarks\OcrBenchmark -c Release -- --manifest fixtures/channel-replay/manifest.json --search-empty --require-safe --minimum-correct 10
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
dotnet run --project benchmarks\OcrBenchmark -c Release -- --manifest fixtures/challenging/line-disagreement.json --search-empty --require-safe --minimum-correct 10
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
dotnet run --project benchmarks\OcrBenchmark -c Release -- --manifest fixtures/validation-holdout/ambiguous-regression.json --search-empty --require-safe
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
dotnet run --project benchmarks\OcrBenchmark -c Release -- --manifest fixtures/validation-holdout/ambiguous-regression.json --baseline --require-safe
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
dotnet run --project benchmarks\OcrBenchmark -c Release -- --manifest fixtures/validation-final/conflicting-regression.json --search-empty --require-safe
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
dotnet run --project benchmarks\OcrBenchmark -c Release -- --manifest fixtures/validation-independent/clipped-baseline-regression.json --baseline --require-safe
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
dotnet run --project benchmarks\CaptureBenchmark -c Release -- --app-baseline
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
dotnet run --project benchmarks\CaptureBenchmark -c Release -- --app-clipped
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
dotnet run --project benchmarks\CaptureBenchmark -c Release -- --app-simulated
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
dotnet run --project benchmarks\CaptureBenchmark -c Release -- --app-during-baseline
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
dotnet run --project benchmarks\CaptureBenchmark -c Release -- --paste-bridge-test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($WithClipboard) {
    dotnet run --project benchmarks\CaptureBenchmark -c Release -- --app-integration
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
if ($Soak) {
    dotnet run --project benchmarks\CaptureBenchmark -c Release -- --app-soak
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
exit 0
