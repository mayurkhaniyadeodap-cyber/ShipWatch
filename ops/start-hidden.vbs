' Launches the ShipWatch keep-alive wrapper with NO visible window.
' A copy of this file is placed in the user's Startup folder so ShipWatch starts
' automatically at logon; the wrapper it calls restarts the server if it crashes.
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""C:\Users\DeoDap\Desktop\projects\P\ShipWatch\ops\watchdog.ps1""", 0, False
