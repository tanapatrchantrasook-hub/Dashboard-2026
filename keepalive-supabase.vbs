' keepalive-supabase.vbs — runs the Supabase keep-alive ping HIDDEN (no console window).
' Launched daily by the "Supabase Keepalive (Pete Dashboard)" Windows scheduled task.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
' Window style 0 = hidden; False = don't wait.
sh.Run "node """ & dir & "\keepalive-supabase.js""", 0, False
