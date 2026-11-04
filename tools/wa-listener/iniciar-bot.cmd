@echo off
rem Inicia o bot do canal manualmente (o app Release V3 ja inicia o bot sozinho).
rem Use este arquivo para o primeiro pareamento por QR code ou para depurar.
rem Os canais ficam em canais.txt. Feche o app antes, para nao rodar dois bots.
cd /d "%~dp0"
title XboxKeyWatcher - bot do canal
node listener.mjs --auth auth-secundario
pause
