@echo off
cd /d C:\Users\yisle\surtihogar
echo ⏳ Iniciando Bot de Telegram para Gestion de Turnos...
node scripts/telegram_bot.js >> scripts/telegram_bot_log.txt 2>&1
pause
