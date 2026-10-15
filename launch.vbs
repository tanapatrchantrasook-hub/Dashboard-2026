' Pete's Trade Dash — start the dashboard (portable: runs from this file's own folder).
' The server itself opens http://localhost:3000 in your browser once it's running,
' so this just needs to start the server. (Don't open the .html file directly — that's
' the file:// route where saving silently fails.)
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
' Hidden (window style 0) so no console window pops up while the server runs.
WshShell.Run "cmd /c taskkill /f /im node.exe >nul 2>&1 & timeout /t 1 >nul & cd /d """ & scriptDir & """ && npm start", 0, False
