' Pete's Trade Dash — pull the latest code from GitHub, then start the dashboard.
' Double-click this to update to the newest version and launch in one step.
' The server itself opens http://localhost:3000 in your browser once it's running,
' so this just needs to update + start the server. (Don't open the .html file directly —
' that's the file:// route where saving silently fails.)
' (Portable: runs from this file's own folder, so it works on any computer.)
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
' Stop any running server, pull latest code (window stays visible so you can see the result), then start.
WshShell.Run "cmd /c taskkill /f /im node.exe >nul 2>&1 & cd /d """ & scriptDir & """ & echo Updating from GitHub... & git pull & echo. & echo Starting dashboard... & npm start", 1, False
