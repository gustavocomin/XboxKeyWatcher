$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$env:PYINSTALLER_CONFIG_DIR = Join-Path (Get-Location) 'build\pyinstaller-cache'
& '.\.venv\Scripts\python.exe' -m PyInstaller --noconfirm --onedir --name RapidOcrWorker --collect-all rapidocr_onnxruntime --distpath 'dist\win-x64\rapidocr' --workpath 'build\rapidocr' --specpath 'build\rapidocr' 'src\rapid_worker.py'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
dotnet publish src\XboxKeyWatcher.App\XboxKeyWatcher.App.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o dist\win-x64
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$libs = '.venv\Lib\site-packages\tesserocr.libs'
$model = 'models\tessdata\eng.traineddata'
if (-not (Test-Path $libs) -or -not (Test-Path $model)) { throw 'Tesseract e modelo ausentes; execute scripts/install-dev.ps1.' }
New-Item -ItemType Directory -Force 'dist\win-x64\tesseract', 'dist\win-x64\models\tessdata', 'dist\win-x64\licenses' | Out-Null
Copy-Item -Path "$libs\*.dll" -Destination 'dist\win-x64\tesseract' -Force
Copy-Item -LiteralPath $model -Destination 'dist\win-x64\models\tessdata\eng.traineddata' -Force
$licenses = '.venv\Lib\site-packages\tesserocr-2.12.0.dist-info\licenses'
if (Test-Path $licenses) { Copy-Item -LiteralPath $licenses -Destination 'dist\win-x64\licenses\tesserocr' -Recurse -Force }
exit 0
