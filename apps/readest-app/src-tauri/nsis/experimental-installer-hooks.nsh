; Keep old experimental shortcuts only when a different target owns the new name.
; Uses the target-checking macro already shipped with Tauri's NSIS template.
!macro READEST_X_RENAME_SHORTCUT OLD NEW
  !insertmacro IsShortcutTarget "${OLD}" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 == 1
    ${If} ${FileExists} "${NEW}"
      !insertmacro IsShortcutTarget "${NEW}" "$INSTDIR\${MAINBINARYNAME}.exe"
      Pop $0
      ${If} $0 == 1
        !insertmacro UnpinShortcut "${OLD}"
        Delete "${OLD}"
      ${EndIf}
    ${Else}
      Rename "${OLD}" "${NEW}"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !if "${BUNDLEID}" != "io.github.wenhe233.readestremote.experimental"
    !error "Experimental shortcut migration cannot run for another application"
  !endif
  !if "${MAINBINARYNAME}" != "readest-remote-x"
    !error "Experimental shortcut migration requires the experimental executable"
  !endif
  !insertmacro READEST_X_RENAME_SHORTCUT "$SMPROGRAMS\Readest Remote Experimental.lnk" "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !insertmacro READEST_X_RENAME_SHORTCUT "$SMPROGRAMS\$AppStartMenuFolder\Readest Remote Experimental.lnk" "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !insertmacro READEST_X_RENAME_SHORTCUT "$DESKTOP\Readest Remote Experimental.lnk" "$DESKTOP\${PRODUCTNAME}.lnk"
!macroend
