<#
  ⚠️ 本文件必须保存为 **UTF-8 with BOM**。
     Windows PowerShell 5.1 在没有 BOM 时会按 ANSI 读 .ps1，
     中文里的多字节字符会被拆坏，直接报语法错误（我们踩过这个坑）。

  给局域网玩剧本杀生成一张「手机能信任」的证书
  ==========================================================================
  为什么需要它：浏览器的安全策略规定，只有 **https / localhost** 才允许网页调麦克风。
  手机用 http://<局域网 IP>:5274 打开时，`navigator.mediaDevices` 压根不存在，
  实时语音用不了（打字不受影响）。所以想开麦就得让页面跑在 https 上。

  两种拿到 https 的办法：
    A. 有外网：用隧道（cloudflared 等），域名自带可信证书，手机什么都不用装 —— 最省事；
    B. 没外网/不想依赖隧道：用本脚本自签一张证书，再把公钥装到每台手机上（一次性）。

  本脚本负责 B。用法（在项目根目录执行）：

    powershell -ExecutionPolicy Bypass -File scripts\make-lan-cert.ps1

  产出（默认放 .tools\lan-cert\，已被 .gitignore 忽略）：
    lan.pfx      —— 给房间服务器用：node server/dist/server.mjs --tls-pfx .tools\lan-cert\lan.pfx --tls-pass mmai-lan
    lan.cer      —— 装到手机上（Android：设置→安全→加密与凭据→安装证书→CA 证书；
                    iOS：下载后到 设置→通用→关于本机→证书信任设置 里手动打开信任）
    README.txt   —— 一页纸的安装步骤

  注意：证书里的 SAN 必须包含 **IP 类型的条目**，否则 Chrome 不会认为
  https://10.x.x.x 是「这个名字」。这就是下面用 TextExtension 手写 SAN 的原因，
  直接 `-DnsName 10.0.0.5` 只会生成 DNS 类型的 SAN，Chrome 不认。
#>

param(
  [string]$OutDir = "",
  [string]$Password = "mmai-lan",
  [string]$CommonName = "mmai.lan",
  [int]$ValidYears = 2
)

$ErrorActionPreference = "Stop"

if (-not $OutDir) {
  $root = Split-Path -Parent $PSScriptRoot
  $OutDir = Join-Path $root ".tools\lan-cert"
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# ---- 找出本机所有局域网 IPv4 ----
$ips = @(
  Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -ExpandProperty IPAddress
)
if ($ips.Count -eq 0) {
  Write-Host "没有找到局域网 IPv4 地址，请检查网络连接。" -ForegroundColor Red
  exit 1
}

Write-Host "本机局域网地址：" -NoNewline
Write-Host ($ips -join ", ") -ForegroundColor Cyan
Write-Host ""

# ---- 组装 SAN（DNS + 每个 IP）----
$sanParts = @("DNS=$CommonName") + ($ips | ForEach-Object { "IPAddress=$_" })
$san = $sanParts -join "&"

# ca=1：手机安装证书时（Android「CA 证书」/ iOS 描述文件）要求带 CA 基本约束
$extensions = @(
  "2.5.29.17={text}$san",
  "2.5.29.19={critical}{text}ca=1"
)

Write-Host "正在生成自签证书（$CommonName，有效期 $ValidYears 年）…"
$cert = New-SelfSignedCertificate `
  -Subject "CN=$CommonName" `
  -TextExtension $extensions `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -NotAfter (Get-Date).AddYears($ValidYears) `
  -KeyExportPolicy Exportable `
  -KeyUsage DigitalSignature, KeyEncipherment, CertSign `
  -KeyAlgorithm RSA -KeyLength 2048

$pfxPath = Join-Path $OutDir "lan.pfx"
$cerPath = Join-Path $OutDir "lan.cer"
$secure = ConvertTo-SecureString -String $Password -Force -AsPlainText

Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $secure | Out-Null
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null

# 生成完之后就别留在个人证书库里了，免得以后每次服务都要挑
Remove-Item -Path "Cert:\CurrentUser\My\$($cert.Thumbprint)" -Force

$port = 5274
$lanUrl = "https://$($ips[0]):$port/"

$readme = @"
迷案 · AI 剧本杀 —— 局域网 HTTPS 证书安装说明
==================================================

这个目录里的两个文件：
  lan.pfx   房间服务器用的私钥+证书（自己留着，别外发）
  lan.cer   要装到每台手机上的公钥（可以发给朋友）

一、启动服务器（在项目根目录）
--------------------------------------------------
  node server/dist/server.mjs --tls-pfx .tools\lan-cert\lan.pfx --tls-pass $Password

  看到启动横幅里打印 https:// 开头的地址就对了。

二、让手机信任这张证书（每台手机只需做一次）
--------------------------------------------------
  把 lan.cer 传到手机上（微信/邮件/U 盘都行），然后：

  Android（Chrome）：
    设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书 → 选择 lan.cer
    （部分机型在 设置 → 密码与安全 → 系统安全 → 加密与凭据）

  iOS（Safari）：
    用 Safari 打开 lan.cer 下载 → 设置 → 通用 → VPN 与设备管理 → 安装描述文件
    → 再进 设置 → 通用 → 关于本机 → 证书信任设置 → 打开对 "$CommonName" 的完全信任

三、打开游戏
--------------------------------------------------
  手机浏览器访问：$lanUrl

  验证是否生效：进房间后点顶栏的沟通入口 → 语音这一栏不再提示
  「当前地址不允许浏览器用麦克风」，能点「开麦加入通话」就是成功了。

四、常见问题
--------------------------------------------------
  · 提示「不安全」仍能进页面但开不了麦 → 证书没被信任（或装到了「VPN 和应用」而不是 CA）。
  · 换了 Wi-Fi 或路由器重新分配了 IP → 证书里的 IP 就过期了，重新跑一次本脚本并重装。
  · 不想在手机上装证书 → 改用隧道方案（域名自带可信证书，手机零配置），见 README 的语音一节。
"@

$readmePath = Join-Path $OutDir "README.txt"
$readme | Out-File -FilePath $readmePath -Encoding utf8

Write-Host ""
Write-Host "搞定：" -ForegroundColor Green
Write-Host "  PFX（服务器用）：$pfxPath"
Write-Host "  CER（手机装）  ：$cerPath"
Write-Host "  说明文档       ：$readmePath"
Write-Host ""
Write-Host "启动命令：" -ForegroundColor Cyan
Write-Host "  node server/dist/server.mjs --tls-pfx `"$pfxPath`" --tls-pass $Password"
Write-Host "手机访问：" -ForegroundColor Cyan
Write-Host "  $lanUrl"