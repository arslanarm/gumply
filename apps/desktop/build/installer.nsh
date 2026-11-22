; Gumply's NSIS additions (electron-builder includes build/installer.nsh).
;
; spec/auto-update, D42: an update never closes a running Gumply. With
; `--updated` (an auto-update started by the app as it quits), electron-
; builder's stock check force-kills every process running from $INSTDIR,
; which would include an AI app's `Gumply.exe --mcp`. The app already checks
; before starting the installer; this closes the gap of a process started in
; the seconds since: wait for the quitting app to exit, and if anything from
; $INSTDIR still runs after that, quit without installing. The update stays
; pending and is tried again at the next quit.
;
; Manual installs (no `--updated`) keep electron-builder's stock behaviour:
; the "Gumply is running, close it?" prompt.

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  ${if} ${isUpdated}
    StrCpy $R1 0
    gumplyUpdateWait:
      !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
      ${if} $R0 == 0
        IntOp $R1 $R1 + 1
        ${if} $R1 > 20
          DetailPrint "Gumply is still running; the update waits for the next quit."
          SetErrorLevel 2
          Quit
        ${endIf}
        Sleep 500
        Goto gumplyUpdateWait
      ${endIf}
  ${else}
    !insertmacro _CHECK_APP_RUNNING
  ${endIf}
!macroend
