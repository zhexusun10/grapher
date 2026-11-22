; Grapher Windows NSIS installer hooks.
;
; 1. Terminate any stray `grapher.exe` sidecar process that could still hold a
;    file lock inside `$INSTDIR\runtime`, then remove stale bundled `runtime/`
;    and `node/` directories before extracting the new version so deleted files
;    from older Pi baselines cannot survive an in-place upgrade and fail
;    `.grapher-bundled-manifest.json` verification.
; 2. Notify Windows Explorer to refresh its shell icon cache after install or
;    upgrade so updated application icons appear immediately.

!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'cmd.exe /C taskkill /F /IM grapher.exe >NUL 2>&1'
  Pop $0
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\node"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  System::Call 'shell32.dll::SHChangeNotify(l, l, i, i) v (0x08000000, 0, 0, 0)'
!macroend
