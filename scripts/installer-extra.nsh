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
; 新安装器装完文件后（customInstall）再搬回。普通卸载不搬移（数据随程序一起删除）。

; 仅在卸载器构建中声明（主安装器构建不引用该变量，NSIS 会把未使用变量当错误）
!ifdef BUILD_UNINSTALLER
  Var /GLOBAL launcherBackupFailed
!endif

!macro launcherMoveData NAME
  ${If} ${FileExists} "$INSTDIR\${NAME}\*.*"
    RMDir /r "$TEMP\DeepSeekHarnessLauncher-update-backup\${NAME}"
    Rename "$INSTDIR\${NAME}" "$TEMP\DeepSeekHarnessLauncher-update-backup\${NAME}"
    ${If} ${FileExists} "$INSTDIR\${NAME}\*.*"
      StrCpy $launcherBackupFailed "1"
    ${EndIf}
  ${EndIf}
!macroend

!macro launcherRestoreData NAME
  ${If} ${FileExists} "$TEMP\DeepSeekHarnessLauncher-update-backup\${NAME}\*.*"
    Rename "$TEMP\DeepSeekHarnessLauncher-update-backup\${NAME}" "$INSTDIR\${NAME}"
  ${EndIf}
!macroend

!macro customUnInstall
  ; 仅在升级时备份数据目录（普通卸载则随程序一并删除）
  ${if} ${isUpdated}
    StrCpy $launcherBackupFailed ""
    DetailPrint 'Upgrade: moving data directories out of the way...'
    CreateDirectory "$TEMP\DeepSeekHarnessLauncher-update-backup"
    !insertmacro launcherMoveData config
    !insertmacro launcherMoveData runtime
    !insertmacro launcherMoveData cache
    !insertmacro launcherMoveData data
    !insertmacro launcherMoveData logs
    !insertmacro launcherMoveData source
    ${If} $launcherBackupFailed == "1"
      ; 有任何目录搬不走就全部回滚并中止：宁可升级失败也不能丢数据
      !insertmacro launcherRestoreData config
      !insertmacro launcherRestoreData runtime
      !insertmacro launcherRestoreData cache
      !insertmacro launcherRestoreData data
      !insertmacro launcherRestoreData logs
      !insertmacro launcherRestoreData source
      MessageBox MB_OK|MB_ICONEXCLAMATION "升级中止：无法安全备份数据目录（可能有文件被占用）。请先退出启动器并停止 DeepSeek Harness 后重试。"
      Abort
    ${EndIf}
  ${endif}
!macroend

!macro customInstall
  ; 升级时先把暂存的数据目录搬回安装目录
  ${If} ${FileExists} "$TEMP\DeepSeekHarnessLauncher-update-backup\*.*"
    DetailPrint 'Upgrade: restoring data directories...'
    !insertmacro launcherRestoreData config
    !insertmacro launcherRestoreData runtime
    !insertmacro launcherRestoreData cache
    !insertmacro launcherRestoreData data
    !insertmacro launcherRestoreData logs
    !insertmacro launcherRestoreData source
    RMDir "$TEMP\DeepSeekHarnessLauncher-update-backup"
  ${EndIf}
  ; 补齐目录并授权：装到 Program Files 也能在无管理员时运行
  CreateDirectory "$INSTDIR\config"
  CreateDirectory "$INSTDIR\runtime"
  CreateDirectory "$INSTDIR\cache"
  CreateDirectory "$INSTDIR\data"
  CreateDirectory "$INSTDIR\logs"
  nsExec::ExecToLog 'icacls "$INSTDIR" /grant:r "*S-1-5-32-545":(OI)(CI)M /Q'
!macroend
