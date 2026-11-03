$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not (Test-Path '.venv\Scripts\python.exe')) { python -m venv .venv; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
& '.\.venv\Scripts\python.exe' -m pip install 'rapidocr-onnxruntime==1.2.3' 'pillow==13.0.0' 'ziglang==0.16.0' 'tesserocr==2.12.0' 'pywin32==312' 'pyinstaller==6.22.3'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
New-Item -ItemType Directory -Force models\tessdata | Out-Null
if (-not (Test-Path models\tessdata\eng.traineddata)) { Invoke-WebRequest 'https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata' -OutFile models\tessdata\eng.traineddata }
dotnet restore src\XboxKeyWatcher.App\XboxKeyWatcher.App.csproj
exit $LASTEXITCODE
