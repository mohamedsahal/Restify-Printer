; Closing the main window only hides the app; Restify Printer.exe stays running (tray).
; NSIS then cannot replace files. End the process before install/update.
!macro customInit
  DetailPrint "Stopping Restify Printer if it is running..."
  nsExec::ExecToLog 'taskkill /F /IM "Restify Printer.exe" /T'
  Sleep 800
!macroend
