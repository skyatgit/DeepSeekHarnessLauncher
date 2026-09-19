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
  Var /GLOBAL launcherRunning
!else
  Var /GLOBAL launcherAclFailed
!endif

; 暂存目录：!define 的值不带引号，使用处再自行加引号（NSIS 的 !define 会保留引号字符）
!ifdef LAUNCHER_BACKUP
  !undef LAUNCHER_BACKUP
!endif
!define LAUNCHER_BACKUP $TEMP\DeepSeekHarnessLauncher-update-backup

; 目录里是否有真实条目（空目录也算「没有」）。NSIS 没有现成的「目录是否为空」判断，
; 而 ${FileExists} "<目录>\*.*" 对空目录同样为真——用它判断会把空目录误当成有数据。
; 注意：FindFirst 对 "*.*" 会**先返回 "." 伪条目**（实测如此），必须 FindNext 跳过 "." 与 ".."，
; 否则非空目录也会被判成空目录。
; $R5/$R6 只在本宏内使用，调用点不依赖它们的旧值
!macro launcherDirHasEntries PATH OUT
  StrCpy ${OUT} ""
  ClearErrors
  FindFirst $R5 $R6 "${PATH}\*.*"
  ${DoWhile} $R6 != ""
    ${If} $R6 != "."
    ${AndIf} $R6 != ".."
      StrCpy ${OUT} "1"
      ${ExitDo}
    ${EndIf}
    ClearErrors
    FindNext $R5 $R6
  ${Loop}
  FindClose $R5
!macroend

!macro launcherMoveData NAME
  ${If} ${FileExists} "$INSTDIR\${NAME}\*.*"
    !insertmacro launcherDirHasEntries "${LAUNCHER_BACKUP}\${NAME}" $R4
    ${If} $R4 != ""
      ; 暂存区里还有**非空**的同名目录 ⇒ 上一次升级没能把它搬回安装目录（例如跨盘复制中途失败）。
      ; 那份残留很可能是唯一副本，先 RMDir 再搬就等于把它删掉，所以这里判失败，
      ; 交给 customUnInstall 回滚并中止升级，由用户按提示手动合并
      DetailPrint 'Upgrade: leftover backup for ${NAME} found; refusing to overwrite it'
      StrCpy $launcherBackupFailed "1"
    ${Else}
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
  ${EndIf}
!macroend

!macro launcherRestoreData NAME
  ${If} ${FileExists} "${LAUNCHER_BACKUP}\${NAME}\*.*"
    !insertmacro launcherDirHasEntries "$INSTDIR\${NAME}" $R4
    ${If} $R4 != ""
      ; 安装目录里已经有非空同名目录：**绝不能**走下面的 xcopy 合并——/Y 会用暂存区里的
      ; 旧副本覆盖安装目录的新数据，随后还会把暂存区（唯一副本）删掉。判为恢复失败并保留暂存区
      DetailPrint 'Upgrade: ${NAME} already exists in $INSTDIR; refusing to merge backup over it'
      StrCpy $launcherRestoreFailed "1"
    ${Else}
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
; ExecWait '"...old-uninstaller.exe" /S /KEEP_APP_DATA ...'），用户看不到向导界面；
; 写进安装目录的文件才是可靠的通知渠道。
; LABEL 必须由调用方传入且全局唯一（本宏在安装器与卸载器里各插入一次，同名标签会编译失败）
; 升级前先确认启动器没有在运行：它（以及它启动的 dsh）会占住 runtime\node\node.exe 等文件，
; 使「把数据目录搬到暂存区」失败，用户看到的却是一句含糊的「无法安全备份数据目录」。
; 关键陷阱：关闭主面板窗口只是**隐藏到托盘**，进程仍在跑——所以这里直接给出这个提示。
; 检测方式：tasklist 按映像名过滤，命中时首行就是 "DeepSeekHarnessLauncher.exe",...
; launcherRunning 只在卸载器构建里使用（见文件顶部的变量声明）

; 探测某个文件是否正被运行中的进程占用：Windows 不允许对正在运行的映像写入，所以
; 「以追加方式打开」失败就说明它还在跑。只用于**数据目录**里的文件——安装器已把
; runtime\ 等数据目录授权给普通用户写，因此该判断在两种安装模式下都准确；
; 不要用它探测 Program Files 根目录里的程序文件（那里普通用户只读，空闲文件也会被拒）
!macro launcherProbeBusy PATH
  ${If} ${FileExists} "${PATH}"
    ClearErrors
    FileOpen $R1 "${PATH}" a
    ${If} ${Errors}
      StrCpy $launcherRunning "1"
    ${Else}
      FileClose $R1
    ${EndIf}
  ${EndIf}
!macroend

!macro launcherCheckLauncherRunning
  StrCpy $launcherRunning ""
  ; dsh 的 node.exe 就住在 runtime\ 里：它还在跑，搬到暂存区的操作必然失败
  !insertmacro launcherProbeBusy "$INSTDIR\runtime\node\node.exe"
!macroend

; 统一的消息框入口。两个要点：
; 1) 必须带 /SD：旧卸载器是被 installUtil 以 /S 静默调用、并用 ExecWait 等待返回的，
;    而没有 /SD 的 MessageBox 在静默模式下依然会弹出并**永久阻塞**，用户看到的是「升级卡住」
;    （installUtil 还会重试，于是连环弹窗）。/SD 必须写在文本之后。
; 2) 编译期定义 LAUNCHER_NO_UI 可让测试探针完全不弹窗（真实构建不定义它）
!macro launcherMsg TEXT
  !ifndef LAUNCHER_NO_UI
    MessageBox MB_OK|MB_ICONEXCLAMATION "${TEXT}" /SD IDOK
  !endif
!macroend

; ============ 0. 安装明细窗口：保持 electron-builder 默认（不显示） ============
; 模板（common.nsh:5/7）写死 ShowInstDetails nevershow / ShowUninstDetails nevershow，
; 这里**故意不再覆盖**，安装界面就是标准安装包的进度条。
; 原因：这个打包方式下，明细窗口里没有真正有用的内容，全靠脚本自己打行。实测结论
; （同一套 makensis + nsis7z 插件做的探针）：
;   · File           → 逐文件打 "Extract: <文件名>"（NSIS 里唯一会逐文件打印的指令）
;   · SetOutPath     → "Output folder: <目录>"      CreateDirectory → "Create folder: <目录>"
;   · CopyFiles      → 无论加不加 /SILENT 都只打一条 "Copy to: <目标目录>"（去掉 /SILENT 无效）
;   · Nsis7z::Extract / ExtractWithDetails → 一行都不打（返回空字符串 = 成功）
; 而 electron-builder 把整个 app 打成一个 app-64.7z 交给 Nsis7z 整包解压，再 CopyFiles 搬进
; 安装目录（见模板 include\extractAppPackage.nsh:97/108），全程只有一条 File（就是那个 7z 包，
; 于是明细里只有 "Extract: app-64.7z…"）。也就是说：不接管 NSIS 模板（nsis.script 或构建时
; 改模板）就拿不到逐文件信息——所以显示明细只会给出一堆无意义的行，不如保持默认隐藏。
; 另外这个 NSIS 构建没有编日志模块：写 LogSet 会直接编译失败（NSIS_CONFIG_LOG not defined），
; 即"自带的 install.log"在标准工具链下也不存在（需要 customNsisBinary.debugLogging + 自定义二进制）。
; 需要诊断时看安装目录的 UPGRADE-DATA-WARNING.txt 和启动器日志（%APPDATA%\DeepSeekHarnessLauncher\logs）。
; 下面的 DetailPrint 行保留：明细关闭时它们什么都不显示，但开启后（改这里即可）仍是有用的步骤说明。

!macro launcherWriteWarning TEXT LABEL
  ClearErrors
  FileOpen $R8 "$INSTDIR\UPGRADE-DATA-WARNING.txt" w
  IfErrors ${LABEL}
  ; 必须用 FileWriteUTF16LE：NSIS 的 FileWrite 按**系统 ANSI 代码页**落盘（本机是 CP936），
  ; 而启动器按 UTF-8 读，中文会变成一串替换字符——这条唯一的升级警告就白写了。
  ; 首行写成纯 ASCII 的产品名，启动器据此识别「无 BOM 的 UTF-16LE」（见 main.js decodeTextFile）。
  FileWriteUTF16LE $R8 "DeepSeekHarnessLauncher$\r$\n"
  FileWriteUTF16LE $R8 "升级数据迁移出现问题$\r$\n$\r$\n"
  FileWriteUTF16LE $R8 "说明：${TEXT}$\r$\n$\r$\n"
  FileWriteUTF16LE $R8 "数据暂存位置：${LAUNCHER_BACKUP}$\r$\n"
  FileWriteUTF16LE $R8 "请先把其中的目录手动移回 $INSTDIR（缺哪一个就移哪一个）。$\r$\n"
  FileWriteUTF16LE $R8 "确认数据无误后可删除本文件。$\r$\n"
  FileClose $R8
  ${LABEL}:
!macroend

!macro customUnInstall
  ${if} ${isUpdated}
    ; ---- 升级：先确认启动器已退出，再搬数据 ----
    !insertmacro launcherCheckLauncherRunning
    ${If} $launcherRunning == "1"
      ; 不弹窗：与正常安装包一致——失败原因写进安装目录的说明文件，启动器下次启动会显示到面板日志；
      ; 退出码非零让 installUtil 按它自己的失败流程处理
      !insertmacro launcherWriteWarning "检测到 DeepSeek Harness（dsh）仍在运行、运行时仍被占用，本次升级在改动任何数据之前就已中止。" launcherRunningWarningDone
      SetErrorLevel 1
      Abort
    ${EndIf}
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
      !insertmacro launcherWriteWarning "无法安全备份数据目录（磁盘空间不足、文件被占用，或暂存区里还有上次未搬回的数据），本次升级已中止。" launcherUninstallWarningDone
      ; 同样不弹窗：原因已写进说明文件，退出码非零交给 installUtil 的正常失败流程
      ; 让「中止」真正生效：Abort 只结束本节，退出码仍是 0，安装器会当成卸载成功继续往下装。
      ; SetErrorLevel 非零后，installUtil.nsh 的 uninstallOldVersion/handleUninstallResult
      ; 会弹出「卸载失败」并 Quit，升级才真的停下来。
      SetErrorLevel 1
      Abort
    ${EndIf}
  ${else}
    ; ---- 普通卸载：数据会随安装目录一起删除，先明确确认 ----
    ; 注意 NSIS 的 /SD 必须写在文本之后（与 electron-builder 模板一致）：
    ; 没有 /SD 时，静默卸载会弹框并永久阻塞
    !ifndef LAUNCHER_NO_UI
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "卸载将删除安装目录下的全部本地数据，且无法恢复：$\r$\n$\r$\n  runtime\  （便携 Node.js / Git / pnpm）$\r$\n  source\   （DeepSeek Harness 源码与构建产物）$\r$\n  data\     （会话 / 配置 / API 密钥，DSH_HOME）$\r$\n  config\  logs\  cache\$\r$\n$\r$\n如需保留，请先取消卸载并手动备份上述目录。确定继续卸载？" /SD IDOK IDOK launcherUninstallConfirmed
      Abort
    !endif
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
      ; 不弹窗：原因写进安装目录的说明文件（启动器下次启动会显示到面板日志），暂存内容原样保留
      !insertmacro launcherWriteWarning "部分数据未能自动恢复到安装目录。" launcherInstallWarningDone
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
    ; 授权失败不让安装失败，但启动器可能无法写入程序目录，必须明确告知。
    ; 走 launcherMsg：带 /SD（静默安装/升级时不会弹框阻塞），也支持测试用的 LAUNCHER_NO_UI
    !insertmacro launcherMsg "警告：未能为程序目录授予普通用户权限（icacls 失败）。$\r$\n程序已安装，但可能需要以管理员身份运行；也可以卸载后改装到用户目录（如 %LOCALAPPDATA%\Programs）。"
  ${EndIf}
!macroend
