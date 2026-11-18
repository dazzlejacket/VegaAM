; Custom NSIS installer hook for VegaAM
;
; 1. Cleans up obsolete shortcuts that display a foreign icon:
;    - "SiriusXM Desktop.lnk" (legacy 0.1.0 install, old ring icon),
;    - "Electron.lnk" (development leftover that advertises the VegaAM
;      AppUserModelId "app.vegaam.desktop" while pointing at
;      node_modules\electron\dist\electron.exe - the reason Windows drew the
;      stock Electron nucleus in the taskbar instead of the V-star).
;    "%APPDATA%\SiriusXM Desktop" user data is never touched.
; 2. Registers the explicit Windows AppUserModelId ("app.vegaam.desktop") and IconUri.
; 3. Notifies the Windows Explorer shell to refresh its icon cache immediately.

!macro customInstall
  ; Remove obsolete SiriusXM Desktop 0.1.0 shortcuts if present (never touch %APPDATA%\SiriusXM Desktop)
  IfFileExists "$SMPROGRAMS\SiriusXM Desktop.lnk" 0 +2
    Delete "$SMPROGRAMS\SiriusXM Desktop.lnk"
  IfFileExists "$DESKTOP\SiriusXM Desktop.lnk" 0 +2
    Delete "$DESKTOP\SiriusXM Desktop.lnk"

  ; Remove the development shortcut that squats the VegaAM AppUserModelId with
  ; the stock Electron nucleus icon
  IfFileExists "$SMPROGRAMS\Electron.lnk" 0 +2
    Delete "$SMPROGRAMS\Electron.lnk"
  IfFileExists "$DESKTOP\Electron.lnk" 0 +2
    Delete "$DESKTOP\Electron.lnk"

  ; Register explicit AppUserModelId and IconUri for Windows taskbar / toast identity
  WriteRegStr HKCU "Software\Classes\AppUserModelId\app.vegaam.desktop" "DisplayName" "VegaAM"
  WriteRegStr HKCU "Software\Classes\AppUserModelId\app.vegaam.desktop" "IconUri" "$INSTDIR\VegaAM.exe"
  WriteRegStr HKCU "Software\Classes\AppUserModelId\app.vegaam.desktop" "IconBackgroundColor" "FF090D1A"

  ; Notify the Windows shell of association/shortcut changes and refresh the icon cache
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
  ExecWait '"$SYSDIR\ie4uinit.exe" -show'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\AppUserModelId\app.vegaam.desktop"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
