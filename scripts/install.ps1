# Installs Revisions for the current user on Windows, or upgrades it.
# It needs no administrator rights. To run it, open Windows PowerShell from
# the Start menu and paste:
#
#   irm -UseBasicParsing https://github.com/ryan-ressmeyer/revisions/releases/latest/download/install.ps1 | iex
#
# It downloads the program from the latest release, checks it against the
# release's SHA256SUMS file, adds Revisions to the Start menu, and then reports
# whether Git and LaTeX are installed.
# REVISIONS_DOWNLOAD_URL replaces the release address, which tests use.

# The braces keep these settings out of the PowerShell window that runs this.
& {
	$ErrorActionPreference = 'Stop'
	# The progress bar makes downloads very slow in Windows PowerShell 5.1.
	$ProgressPreference = 'SilentlyContinue'
	$url = 'https://github.com/ryan-ressmeyer/revisions/releases/latest/download'
	if ($env:REVISIONS_DOWNLOAD_URL) { $url = $env:REVISIONS_DOWNLOAD_URL }
	$docs = 'https://github.com/ryan-ressmeyer/revisions/blob/main/docs'

	if (-not [Environment]::Is64BitOperatingSystem) {
		throw 'Revisions was not installed: it needs 64-bit Windows.'
	}
	# Windows on Arm runs this x64 program through its emulation.
	$asset = 'revisions-windows-amd64.exe'
	$dir = "$env:LOCALAPPDATA\Programs\Revisions"
	$exe = "$dir\revisions.exe"
	$new = "$exe.download"
	New-Item -ItemType Directory -Force $dir | Out-Null

	function Download($from, $to) {
		try { Invoke-WebRequest -UseBasicParsing $from -OutFile $to }
		catch { throw "Revisions was not installed: could not download $from ($($_.Exception.Message))" }
	}

	Write-Host 'Downloading Revisions for windows/amd64...'
	try {
		Download "$url/$asset" $new
		Download "$url/SHA256SUMS" "$new.sums"
		$line = Get-Content "$new.sums" | Where-Object { $_ -like "* $asset" } | Select-Object -First 1
		# .NET rather than Get-FileHash, which is missing when Windows PowerShell
		# is started from PowerShell 7.
		$sha = [Security.Cryptography.SHA256]::Create()
		$got = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($new))) -replace '-', ''
		if (-not $line -or ($line -split ' ')[0] -ne $got) {
			throw 'Revisions was not installed: the download does not match its checksum. Nothing was changed. Try again later.'
		}
		# Windows cannot replace a running program, so stop a copy that was
		# opened from the Start menu.
		foreach ($p in Get-Process revisions -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }) {
			Stop-Process -InputObject $p -Force -ErrorAction SilentlyContinue
			$p.WaitForExit(10000) | Out-Null
		}
		Move-Item -Force $new $exe
	}
	finally {
		Remove-Item -Force -ErrorAction SilentlyContinue $new, "$new.sums"
	}

	$programs = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs"
	New-Item -ItemType Directory -Force $programs | Out-Null
	$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut("$programs\Revisions.lnk")
	$shortcut.TargetPath = $exe
	# 7 is minimized: Revisions shows itself in the browser, its window waits
	# in the taskbar, and closing that window quits Revisions.
	$shortcut.WindowStyle = 7
	$shortcut.Save()

	Write-Host "Installed $(& $exe --version)."
	Write-Host 'Open it from the Start menu: press the Windows key, type Revisions, and press Enter.'

	# Revisions needs Git to fetch the manuscript and LaTeX to build the PDF.
	Write-Host ''
	if (Get-Command git -ErrorAction SilentlyContinue) {
		Write-Host 'Git: found.'
	}
	else {
		Write-Host "Git: not found. Install Git for Windows: see $docs/install-windows.md"
	}
	$texPlaces = "$env:LOCALAPPDATA\Programs\MiKTeX\miktex\bin\x64", "$env:ProgramFiles\MiKTeX\miktex\bin\x64", 'C:\texlive\*\bin\windows'
	if ((Get-Command latexmk -ErrorAction SilentlyContinue) -or ($texPlaces | Where-Object { Test-Path "$_\latexmk.exe" })) {
		Write-Host 'LaTeX: found.'
	}
	else {
		Write-Host "LaTeX: not found. Revisions needs it to build the PDF. See $docs/install-windows.md"
	}
}
