@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================
echo   Deploy Sistema Prenotazioni su Cloudflare
echo ================================================
echo.
echo Se si apre il browser, clicca "Allow" per autorizzare.
echo.
call npx -y wrangler pages deploy public --project-name=prenotazioni --commit-dirty=true
echo.
echo ================================================
echo   FINITO. Cerca qui sopra la riga con l'indirizzo
echo   che finisce con  .pages.dev
echo ================================================
echo.
pause
