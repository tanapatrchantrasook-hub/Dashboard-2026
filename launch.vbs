Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c taskkill /f /im node.exe >nul 2>&1 & timeout /t 1 >nul & cd /d ""C:\Users\TanapatrChantrasook\Desktop\Petes Trading Dashboard 2026"" && npm start", 1, False
