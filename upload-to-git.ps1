<#
.SYNOPSIS
    将项目目录提交并推送到 Git 仓库。

.DESCRIPTION
    默认上传当前目录下的 multi_agent 文件夹。脚本会：
      1. 检查 Git 与目录；
      2. 未初始化时执行 git init；
      3. 暂存全部改动并提交；
      4. 配置 origin（可选）；
      5. 推送到指定分支。

    默认不强制推送，避免覆盖远端历史。

.PARAMETER RepoPath
    要上传的项目目录。默认是脚本所在目录下的 multi_agent。

.PARAMETER RemoteUrl
    远端仓库地址。首次运行或需要更换 origin 时传入，例如：
    git@github.com:your-name/multi_agent.git
    https://github.com/your-name/multi_agent.git

.PARAMETER Branch
    推送分支，默认 main。

.PARAMETER Message
    提交说明。默认使用当前时间生成。

.EXAMPLE
    .\upload-to-git.ps1 -RemoteUrl "git@github.com:your-name/multi_agent.git"

.EXAMPLE
    .\upload-to-git.ps1 -RepoPath . -Branch dev -Message "feat: 更新插件"
#>

[CmdletBinding()]
param(
    [string]$RepoPath = (Join-Path $PSScriptRoot 'multi_agent'),

    [string]$RemoteUrl,

    [string]$Branch = 'main',

    [string]$Message = ("chore: update {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm'))
)

Set-StrictMode -Version Latest
# Git 在 Windows PowerShell 5.1 下会把正常的探测失败写入 stderr。
# 保持 Continue，避免非零退出码在显式检查前被当成终止错误。
$ErrorActionPreference = 'Continue'

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [switch]$AllowFailure
    )

    & git -C $script:repo @Arguments
    $code = $LASTEXITCODE
    if ($code -ne 0 -and -not $AllowFailure) {
        throw "git $($Arguments -join ' ') 执行失败（退出码 $code）"
    }
    return $code
}

try {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw '未找到 git，请先安装 Git 并加入 PATH。'
    }

    if (-not (Test-Path -LiteralPath $RepoPath -PathType Container)) {
        throw "项目目录不存在：$RepoPath"
    }

    $script:repo = (Resolve-Path -LiteralPath $RepoPath).Path

    & git -C $script:repo rev-parse --is-inside-work-tree *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "初始化 Git 仓库：$script:repo" -ForegroundColor Cyan
        Invoke-Git @('init') | Out-Null
    }

    $name = (& git -C $script:repo config user.name 2>$null)
    $email = (& git -C $script:repo config user.email 2>$null)
    if ([string]::IsNullOrWhiteSpace($name) -or [string]::IsNullOrWhiteSpace($email)) {
        throw @'
Git 提交身份未配置。请先执行：

  git config --global user.name "你的名字"
  git config --global user.email "你的邮箱"

配置后重新运行本脚本。
'@
    }

    Write-Host "暂存项目文件：$script:repo" -ForegroundColor Cyan
    Invoke-Git @('add', '-A') | Out-Null

    & git -C $script:repo diff --cached --quiet
    $hasStagedChanges = ($LASTEXITCODE -ne 0)

    if ($hasStagedChanges) {
        Write-Host "提交：$Message" -ForegroundColor Cyan
        Invoke-Git @('commit', '-m', $Message) | Out-Null
    }
    else {
        Write-Host '没有新的文件改动，跳过提交。' -ForegroundColor Yellow
    }

    & git -C $script:repo rev-parse --verify HEAD *> $null
    if ($LASTEXITCODE -ne 0) {
        throw '仓库中没有任何提交，请确认项目目录包含文件。'
    }

    # 统一落到目标分支；已有提交时只改分支名，不切换工作区文件。
    $currentBranch = (& git -C $script:repo symbolic-ref --quiet --short HEAD 2>$null)
    if ($currentBranch -ne $Branch) {
        Invoke-Git @('branch', '-M', $Branch) | Out-Null
        Write-Host "当前分支：$Branch" -ForegroundColor Cyan
    }

    if ($RemoteUrl) {
        & git -C $script:repo remote get-url origin *> $null
        if ($LASTEXITCODE -eq 0) {
            Invoke-Git @('remote', 'set-url', 'origin', $RemoteUrl) | Out-Null
            Write-Host '已更新 origin。' -ForegroundColor Cyan
        }
        else {
            Invoke-Git @('remote', 'add', 'origin', $RemoteUrl) | Out-Null
            Write-Host '已添加 origin。' -ForegroundColor Cyan
        }
    }

    & git -C $script:repo remote get-url origin *> $null
    if ($LASTEXITCODE -ne 0) {
        throw @'
尚未配置远端仓库。请传入 -RemoteUrl，例如：

  .\upload-to-git.ps1 -RemoteUrl "git@github.com:your-name/multi_agent.git"
'@
    }

    Write-Host "推送到 origin/$Branch ..." -ForegroundColor Cyan
    Invoke-Git @('push', '-u', 'origin', $Branch) | Out-Null

    $commit = (& git -C $script:repo rev-parse --short HEAD)
    Write-Host "完成：已推送提交 $commit 到 origin/$Branch" -ForegroundColor Green
}
catch {
    Write-Host "上传失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
