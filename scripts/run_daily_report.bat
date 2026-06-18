@echo off
cd /d "C:\Users\yisle\surtihogar"
echo === EJECUCION DE REPORTE DIARIO %date% %time% === >> scripts\report_log.txt
node scripts\send_daily_report.js >> scripts\report_log.txt 2>&1
echo ================================================= >> scripts\report_log.txt
