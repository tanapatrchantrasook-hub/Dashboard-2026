' Pete's Trade Dash — start the server AND open the dashboard in your browser.
' Double-click this to launch and open everything in one step (no GitHub update).
' (Portable: runs from this file's own folder.)
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

' Stop any running server, then start a fresh one.
WshShell.Run "cmd /c taskkill /f /im node.exe >nul 2>&1 & timeout /t 1 >nul & cd /d """ & scriptDir & """ && npm start", 1, False

' Wait until the server is actually answering, then open the dashboard in your default browser.
' Opening http://localhost:3000 (NOT the .html file) is what makes saving work.
url = "http://localhost:3000"
ready = False
For i = 1 To 40                       ' try for up to ~40 seconds while the server starts
    WScript.Sleep 1000
    On Error Resume Next
    Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
    http.Open "GET", url, False
    http.Send
    If Err.Number = 0 And http.Status = 200 Then ready = True
    Err.Clear
    On Error GoTo 0
    If ready Then Exit For
Next

WshShell.Run url
