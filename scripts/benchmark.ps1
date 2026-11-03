param([switch]$IncludeClipboard)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$py = '.\.venv\Scripts\python.exe'
if (-not (Test-Path $py)) { throw 'Execute scripts/install-dev.ps1 primeiro.' }
function Invoke-Checked([string]$exe, [string[]]$argsList) {
    & $exe @argsList
    if ($LASTEXITCODE -ne 0) { throw "$exe falhou com código $LASTEXITCODE" }
}
Invoke-Checked $py @('benchmarks/generate_fixtures.py')
Invoke-Checked $py @('benchmarks/generate_challenging.py')
Invoke-Checked 'dotnet' @('run','--project','benchmarks/OcrBenchmark','-c','Release')
Invoke-Checked 'dotnet' @('run','--project','benchmarks/OcrBenchmark','-c','Release','--','--manifest','fixtures/challenging/manifest.json','--baseline','--require-safe')
Invoke-Checked 'dotnet' @('run','--project','benchmarks/OcrBenchmark','-c','Release','--','--manifest','fixtures/challenging/manifest.json','--search-empty','--require-safe')
Invoke-Checked 'dotnet' @('run','--project','benchmarks/RapidWorkerBenchmark','-c','Release')
Invoke-Checked $py @('benchmarks/rapidocr_benchmark.py')
Invoke-Checked $py @('benchmarks/rapidocr_benchmark.py','--fast')
Invoke-Checked $py @('benchmarks/tesseract_benchmark.py')
Invoke-Checked $py @('benchmarks/tesseract_benchmark.py','--psm','6')
Invoke-Checked $py @('-m','ziglang','cc','-O3','benchmarks/native/compare.c','-o','benchmarks/native/compare-c.exe')
Invoke-Checked $py @('-m','ziglang','c++','-O3','-Wno-nullability-completeness','-nostdlib++','-x','c++','benchmarks/native/compare.c','-o','benchmarks/native/compare-cpp.exe')
Invoke-Checked $py @('-m','ziglang','cc','-O3','-mavx2','-DUSE_AVX2','benchmarks/native/compare.c','-o','benchmarks/native/compare-avx2.exe')
Invoke-Checked $py @('-m','ziglang','cc','-O3','benchmarks/native/tesseract.c','-o','benchmarks/native/tesseract-c.exe')
Invoke-Checked $py @('-m','ziglang','c++','-O3','-Wno-nullability-completeness','-nostdlib++','-x','c++','benchmarks/native/tesseract.c','-o','benchmarks/native/tesseract-cpp.exe')
Invoke-Checked $py @('-m','ziglang','cc','-O3','benchmarks/native/capture_tesseract.c','-lgdi32','-luser32','-o','benchmarks/native/capture-tesseract-c.exe')
Invoke-Checked $py @('-m','ziglang','c++','-O3','-Wno-nullability-completeness','-nostdlib++','-x','c++','benchmarks/native/capture_tesseract.c','-lgdi32','-luser32','-o','benchmarks/native/capture-tesseract-cpp.exe')
New-Item -ItemType Directory -Force 'benchmarks/results' | Out-Null
foreach ($binary in @('compare-c','compare-cpp','compare-avx2')) {
    & "benchmarks/native/$binary.exe" | Tee-Object -FilePath "benchmarks/results/$binary.txt"
    if ($LASTEXITCODE -ne 0 -and $binary -ne 'compare-avx2') { throw "$binary falhou" }
}
foreach ($binary in @('tesseract-c','tesseract-cpp','capture-tesseract-c','capture-tesseract-cpp')) {
    & "benchmarks/native/$binary.exe" | Tee-Object -FilePath "benchmarks/results/$binary.txt"
    if ($LASTEXITCODE -ne 0) { throw "$binary falhou" }
}
& dotnet run --project benchmarks/PixelBenchmark -c Release | Tee-Object -FilePath benchmarks/results/pixel-csharp.txt
if ($LASTEXITCODE -ne 0) { throw 'Benchmark C# falhou' }
& $py benchmarks/pixel_compare.py | Tee-Object -FilePath benchmarks/results/pixel-python.txt
if ($LASTEXITCODE -ne 0) { throw 'Benchmark Python falhou' }
& $py benchmarks/python_capture_tesseract.py | Tee-Object -FilePath benchmarks/results/capture-tesseract-python.txt
if ($LASTEXITCODE -ne 0) { throw 'Benchmark Python de captura falhou' }
$captureArgs = @('run','--project','benchmarks/CaptureBenchmark','-c','Release')
if (-not $IncludeClipboard) { $captureArgs += @('--','--no-clipboard') }
Invoke-Checked 'dotnet' $captureArgs
if ($IncludeClipboard) {
    foreach ($language in @('c', 'cpp', 'python')) { Invoke-Checked 'dotnet' @('run','--project','benchmarks/CaptureBenchmark','-c','Release','--','--native-clipboard',$language) }
}
Invoke-Checked 'dotnet' @('run','--project','benchmarks/CaptureBenchmark','-c','Release','--','--no-clipboard','--full-size')
