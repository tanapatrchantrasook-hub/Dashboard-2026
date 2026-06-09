' Pete's Trade Dash — start the dashboard (portable: runs from this file's own folder)
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.Run "cmd /c taskkill /f /im node.exe >nul 2>&1 & timeout /t 1 >nul & cd /d """ & scriptDir & """ && npm start", 1, False
