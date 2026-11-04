@echo off
rem Pareia o bot com o NUMERO PRINCIPAL (feche o app XboxKeyWatcher antes).
rem No celular principal: WhatsApp > Aparelhos conectados > Conectar aparelho > escaneie o QR.
rem Quando aparecer "Aguardando posts", feche esta janela (Ctrl+C).
cd /d "%~dp0"
title XboxKeyWatcher - parear numero principal
node listener.mjs --auth auth-principal --no-app
pause
