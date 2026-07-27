' Runs the ShipWatch DB backup with NO console window.
'
' Why this wrapper exists: the ShipWatch-Backup task is scheduled for 03:00, but the
' machine is usually asleep then, so StartWhenAvailable re-fires it at logon — into
' the boot storm, alongside the watchdog starting the server and its first heavy sync.
' Run that way it was terminated mid-VACUUM twice in three days (2026-07-25 09:25 and
' 2026-07-27 09:05), both times with task result 0xC000013A = STATUS_CONTROL_C_EXIT,
' i.e. a console close/Ctrl-Break event rather than a crash of its own. A process
' launched with no console cannot be sent that event, so the backup runs to completion.
'
' bWaitOnReturn = True so the task's reported result is still node's real exit code —
' a failed backup must stay visible in Task Scheduler, since silently-failing backups
' are exactly what this whole fix is about.
Set sh = CreateObject("WScript.Shell")
cmd = """C:\Program Files\nodejs\node.exe"" ""C:\Users\DeoDap\Desktop\projects\P\ShipWatch\ops\backup-db.mjs"""
rc = sh.Run(cmd, 0, True)
WScript.Quit rc
