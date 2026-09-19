; electron-builder 自定义安装/卸载步骤

; ============ 1. 更新判定重定义 ============
; 原判定（electron-builder 生成）只看命令行 --updated（供自动更新器使用）。
; 手动双击新版安装包时命令行是空的，isUpdated 为 false，导致：目录页仍会弹出、
; 快捷方式不会保留、运行中的程序不会静默关闭。
; 这里重定义：命令行带 --updated，或注册表已有安装记录（HKCU/HKLM 的 InstallLocation）
; 都视为更新。效果：检测到已安装 → 只能走更新流程（跳过目录页、沿用已安装目录、保留快捷方式）。
!undef isUpdated
!ifdef BUILD_UNINSTALLER
  ; 卸载器保持原语义：仅认 --updated 标志（否则普通卸载会被误判为升级而暂存数据）
  !define isUpdated `"" isUpdated ""`
!else
  !macro _launcherIsUpdated _a _b _t _f
    ${StdUtils.TestParameter} $R9 "updated"
    StrCmp "$R9" "true" `${_t}` 0
    ReadRegStr $R9 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    StrCmp "$R9" "" 0 `${_t}`
    ReadRegStr $R9 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    StrCmp "$R9" "" `${_f}` `${_t}`
  !macroend
  !define isUpdated `"" launcherIsUpdated ""`
!endif

; ============ 2. 安装模式页：已安装则跳过 ============
; 检测到已安装时，"为谁安装"页不再询问，直接沿用原安装模式（当前用户/所有用户）
!macro customInstallMode
  ReadRegStr $R9 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $R8 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R9 != ""
    StrCpy $isForceCurrentInstall "1"
  ${ElseIf} $R8 != ""
    StrCpy $isForceMachineInstall "1"
  ${EndIf}
!macroend

; ============ 3. 升级数据保护 ============
; 背景：升级安装（再次运行 Setup.exe）时，electron-builder 会先静默运行旧卸载器，
; 旧卸载器会清空整个安装目录（uninstaller.nsh 的 isUpdated 分支）。本程序的环境数据
; （runtime/config/data/logs/source/cache）都放在安装目录里，不处理的话每次升级都会删光。
; 方案：升级时在删除文件之前（customUnInstall）把数据目录搬到临时目录暂存，
; 新安装器装完文件后（customInstall）再搬回。普通卸载不搬移，但会先弹确认。
;
; 搬移采用「先 Rename，失败再 xcopy 递归复制」：NSIS 的 Rename 跨盘可能失败，
; 而 %TEMP% 被重定向到其它盘的企业环境很常见；NSIS 的 CopyFiles 不递归子目录，
; 所以跨卷回退借用 Windows 自带的 xcopy（$SYSDIR\xcopy.exe，系统组件，无需额外依赖）。

; 仅在需要的构建里声明标记变量（另一侧不引用，NSIS 会把未使用变量当错误）：
; launcherRestoreFailed 两个构建都用（安装器恢复数据、卸载器回滚数据）
Var /GLOBAL launcherRestoreFailed
!ifdef BUILD_UNINSTALLER
  Var /GLOBAL launcherBackupFailed
!else
  Var /GLOBAL launcherAclFailed
!endif

; 暂存目录：!define 的值不带引号，使用处再自行加引号（NSIS 的 !define 会保留引号字符）
!ifdef LAUNCHER_BACKUP
  !undef LAUNCHER_BACKUP
!endif
!define LAUNCHER_BACKUP $TEMP\DeepSeekHarnessLauncher-update-backup

!macro launcherMoveData NAME
  ${If} ${FileExists} "$INSTDIR\${NAME}\*.*"
    RMDir /r "${LAUNCHER_BACKUP}\${NAME}"
    ClearErrors
    Rename "$INSTDIR\${NAME}" "${LAUNCHER_BACKUP}\${NAME}"
    ${If} ${Errors}
      ; 跨盘：递归复制后再删源
      ClearErrors
      DetailPrint 'Upgrade: cross-volume move of ${NAME} ...'
      nsExec::ExecToLog '"$SYSDIR\xcopy.exe" /E /I /H /Y /Q "$INSTDIR\${NAME}" "${LAUNCHER_BACKUP}\${NAME}"'
      Pop $0
      ${If} $0 == 0
        RMDir /r "$INSTDIR\${NAME}"
      ${EndIf}
    ${EndIf}
    ; 搬移后源目录若还有文件，说明没搬干净
    ${If} ${FileExists} "$INSTDIR\${NAME}\*.*"
      StrCpy $launcherBackupFailed "1"
    ${EndIf}
  ${EndIf}
!macroend

!macro launcherRestoreData NAME
  ${If} ${FileExists} "${LAUNCHER_BACKUP}\${NAME}\*.*"
    ClearErrors
    Rename "${LAUNCHER_BACKUP}\${NAME}" "$INSTDIR\${NAME}"
    ${If} ${Errors}
      ClearErrors
      DetailPrint 'Upgrade: cross-volume restore of ${NAME} ...'
      nsExec::ExecToLog '"$SYSDIR\xcopy.exe" /E /I /H /Y /Q "${LAUNCHER_BACKUP}\${NAME}" "$INSTDIR\${NAME}"'
      Pop $0
      ${If} $0 == 0
        RMDir /r "${LAUNCHER_BACKUP}\${NAME}"
      ${EndIf}
    ${EndIf}
    ; 暂存区若仍有文件，说明这个目录没恢复成功
    ${If} ${FileExists} "${LAUNCHER_BACKUP}\${NAME}\*.*"
      StrCpy $launcherRestoreFailed "1"
    ${EndIf}
  ${EndIf}
!macroend

; 给一个目录授予标准用户「修改」权限，并检查 icacls 的退出码
!macro launcherGrantModify PATH
  nsExec::ExecToLog 'icacls "${PATH}" /grant:r "*S-1-5-32-545":(OI)(CI)M /Q'
  Pop $0
  ${If} $0 != 0
    StrCpy $launcherAclFailed "1"
  ${EndIf}
!macroend

; 升级数据迁移出问题时写一份说明文件：旧卸载器**总是被静默调用**（installUtil.nsh 用
; ExecWait '"...old-uninstaller.exe" /S /KEEP_APP_DATA ...'），而 NSIS 在静默模式下不显示
; MessageBox，只靠弹窗用户永远看不到；写进安装目录的文件才是可靠的通知渠道。
; LABEL 必须由调用方传入且全局唯一（本宏在安装器与卸载器里各插入一次，同名标签会编译失败）
!macro launcherWriteWarning TEXT LABEL
  ClearErrors
  FileOpen $R8 "$INSTDIR\UPGRADE-DATA-WARNING.txt" w
  IfErrors ${LABEL}
  FileWrite $R8 "DeepSeekHarnessLauncher 升级时数据迁移出现问题$\r$\n$\r$\n"
  FileWrite $R8 "说明：${TEXT}$\r$\n$\r$\n"
  FileWrite $R8 "数据暂存位置：${LAUNCHER_BACKUP}$\r$\n"
  FileWrite $R8 "请先把其中的目录手动移回 $INSTDIR（缺哪一个就移哪一个）。$\r$\n"
  FileWrite $R8 "确认数据无误后可删除本文件。$\r$\n"
  FileClose $R8
  ${LABEL}:
!macroend

!macro customUnInstall
  ${if} ${isUpdated}
    ; ---- 升级：把数据目录搬到临时区暂存，装完再搬回 ----
    StrCpy $launcherBackupFailed ""
    DetailPrint 'Upgrade: moving data directories out of the way...'
    CreateDirectory "${LAUNCHER_BACKUP}"
    !insertmacro launcherMoveData config
    !insertmacro launcherMoveData runtime
    !insertmacro launcherMoveData cache
    !insertmacro launcherMoveData data
    !insertmacro launcherMoveData logs
    !insertmacro launcherMoveData source
    ${If} $launcherBackupFailed == "1"
      ; 有任何目录搬不走就全部回滚并中止：宁可升级失败也不能丢数据
      StrCpy $launcherRestoreFailed ""
      !insertmacro launcherRestoreData config
      !insertmacro launcherRestoreData runtime
      !insertmacro launcherRestoreData cache
      !insertmacro launcherRestoreData data
      !insertmacro launcherRestoreData logs
      !insertmacro launcherRestoreData source
      !insertmacro launcherWriteWarning "无法安全备份数据目录（磁盘空间不足或文件被占用），本次升级已中止。" launcherUninstallWarningDone
      MessageBox MB_OK|MB_ICONEXCLAMATION "升级中止：无法安全备份数据目录（磁盘空间不足或文件被占用）。请先退出启动器并停止 DeepSeek Harness 后重试。"
      ${If} $launcherRestoreFailed == "1"
        MessageBox MB_OK|MB_ICONEXCLAMATION "注意：部分数据未能回滚到安装目录，仍保留在 ${LAUNCHER_BACKUP}$\r$\n请手动移回安装目录后再删除该文件夹。"
      ${EndIf}
      ; 让「中止」真正生效：Abort 只结束本节，退出码仍是 0，安装器会当成卸载成功继续往下装。
      ; SetErrorLevel 非零后，installUtil.nsh 的 uninstallOldVersion/handleUninstallResult
      ; 会弹出「卸载失败」并 Quit，升级才真的停下来。
      SetErrorLevel 1
      Abort
    ${EndIf}
  ${else}
    ; ---- 普通卸载：数据会随安装目录一起删除，先明确确认 ----
    ; 注意 NSIS 的 /SD 必须写在文本之后（与 electron-builder 模板一致）
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "卸载将删除安装目录下的全部本地数据，且无法恢复：$\r$\n$\r$\n  runtime\  （便携 Node.js / Git / pnpm）$\r$\n  source\   （DeepSeek Harness 源码与构建产物）$\r$\n  data\     （会话 / 配置 / API 密钥，DSH_HOME）$\r$\n  config\  logs\  cache\$\r$\n$\r$\n如需保留，请先取消卸载并手动备份上述目录。确定继续卸载？" /SD IDOK IDOK launcherUninstallConfirmed
    Abort
    launcherUninstallConfirmed:
  ${endif}
!macroend

!macro customInstall
  ; 升级时先把暂存的数据目录搬回安装目录
  ${If} ${FileExists} "${LAUNCHER_BACKUP}\*.*"
    DetailPrint 'Upgrade: restoring data directories...'
    StrCpy $launcherRestoreFailed ""
    !insertmacro launcherRestoreData config
    !insertmacro launcherRestoreData runtime
    !insertmacro launcherRestoreData cache
    !insertmacro launcherRestoreData data
    !insertmacro launcherRestoreData logs
    !insertmacro launcherRestoreData source
    ${If} $launcherRestoreFailed == ""
      RMDir /r "${LAUNCHER_BACKUP}"
    ${Else}
      ; 弹窗 + 落盘双保险：用户取消向导或中途关掉也不能丢掉这条线索
      !insertmacro launcherWriteWarning "部分数据未能自动恢复到安装目录。" launcherInstallWarningDone
      MessageBox MB_OK|MB_ICONEXCLAMATION "部分数据未能自动恢复到安装目录，暂存内容仍保留在：$\r$\n${LAUNCHER_BACKUP}$\r$\n请手动移回安装目录后再删除该文件夹。"
    ${EndIf}
  ${EndIf}

  ; 补齐目录：装到 Program Files 也能在无管理员权限下运行。
  ; 可写权限只授予这些数据目录，程序目录本身只给标准用户「读取+执行」——
  ; 否则本机任意用户都能替换 resources\app\main.js，等下一个用户启动时执行
  CreateDirectory "$INSTDIR\config"
  CreateDirectory "$INSTDIR\runtime"
  CreateDirectory "$INSTDIR\cache"
  CreateDirectory "$INSTDIR\data"
  CreateDirectory "$INSTDIR\logs"
  CreateDirectory "$INSTDIR\source"
  StrCpy $launcherAclFailed ""
  nsExec::ExecToLog 'icacls "$INSTDIR" /grant:r "*S-1-5-32-545":(OI)(CI)RX /Q'
  Pop $0
  ${If} $0 != 0
    StrCpy $launcherAclFailed "1"
  ${EndIf}
  !insertmacro launcherGrantModify "$INSTDIR\config"
  !insertmacro launcherGrantModify "$INSTDIR\runtime"
  !insertmacro launcherGrantModify "$INSTDIR\cache"
  !insertmacro launcherGrantModify "$INSTDIR\data"
  !insertmacro launcherGrantModify "$INSTDIR\logs"
  !insertmacro launcherGrantModify "$INSTDIR\source"
  ${If} $launcherAclFailed == "1"
    ; 授权失败不让安装失败，但启动器可能无法写入程序目录，必须明确告知
    MessageBox MB_OK|MB_ICONEXCLAMATION "警告：未能为程序目录授予普通用户权限（icacls 失败）。$\r$\n程序已安装，但可能需要以管理员身份运行；也可以卸载后改装到用户目录（如 %LOCALAPPDATA%\Programs）。"
  ${EndIf}
!macroend
