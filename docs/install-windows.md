# Install Revisions on Windows

Revisions lets you edit a LaTeX manuscript that a co-author shares with you on GitHub. These steps take a Windows PC with nothing extra installed to an open manuscript. You need 64-bit Windows 10 or 11, a GitHub account, an internet connection, and about 8 GB of free disk space. Plan for an afternoon. One of the installs can take several hours, and you can work on other things while it runs.

Revisions needs two free programs besides itself:

- **Git** fetches the manuscript from GitHub and sends your changes back. On Windows it comes as **Git for Windows**.
- **LaTeX** turns the manuscript into a PDF. These steps use **TeX Live**, because it includes everything Revisions needs in one installer.

## 1. Install TeX Live

TeX Live is the long install, so start it first.

1. Open [tug.org/texlive/windows.html](https://tug.org/texlive/windows.html) in your browser and download **install-tl-windows.exe**.
2. Open the downloaded file. If Windows asks whether to allow it to make changes, click **Yes**.
3. Keep the settings the installer suggests and start the installation.

The installer downloads more than 7 GB. TeX Live's documentation says this may take several hours. You do not need administrator rights: it installs to `C:\texlive` and adds itself to your programs. Continue with the next steps while it runs.

**Why not MiKTeX?** MiKTeX is a smaller LaTeX for Windows that installs in a few minutes, but the tool Revisions uses to build PDFs, `latexmk`, needs a separate program called Perl that MiKTeX does not include. If you already use MiKTeX, install Perl as well, or install TeX Live.

## 2. Install Git for Windows

1. Open [git-scm.com/install/windows](https://git-scm.com/install/windows) and download the 64-bit installer (about 67 MB).
2. Open the downloaded file. If Windows asks whether to allow it to make changes, click **Yes**.
3. Click **Next** on every page and then **Install**. The choices it suggests are the right ones for Revisions.

## 3. Install Revisions

This step uses PowerShell, Windows' text command window. You paste one line and press Enter. You need no administrator rights.

1. Press the Windows key, type `PowerShell`, and press Enter.
2. Copy this line, paste it into the PowerShell window (right-click pastes), and press Enter:

   ```powershell
   irm -UseBasicParsing https://github.com/ryan-ressmeyer/revisions/releases/latest/download/install.ps1 | iex
   ```

3. Read the last lines it prints. `Git: not found.` or `LaTeX: not found.` means that install has not finished yet. Revisions finds them once they have.

The installer puts Revisions in `AppData\Local\Programs\Revisions` in your user folder and adds it to the Start menu. To read what it does before you run it, open [the script](https://github.com/ryan-ressmeyer/revisions/releases/latest/download/install.ps1) in your browser.

## 4. Open Revisions

Press the Windows key, type `Revisions`, and press Enter. Your browser opens a Revisions tab.

Revisions also puts a small window in the taskbar. It shows that Revisions is running. Close that window to quit Revisions. Opening Revisions again while it runs brings back the browser tab.

## 5. Sign in with GitHub

1. Click **Sign in with GitHub**. Revisions shows a one-time code.
2. Click **Copy code**, then **Open GitHub in a new tab**.
3. On GitHub, sign in if asked, paste the code, and click **Continue**. Then click **Authorize**.
4. Go back to the Revisions tab. It moves on by itself once GitHub confirms the code.

If you do not have a GitHub account, create one at [github.com/signup](https://github.com/signup) first, and send your user name to your co-author so they can give you access to the manuscript.

## 6. Open the manuscript

1. Copy the GitHub link your co-author sent you.
2. Paste it into the box under **Open a manuscript** and click **Open**.

The first time, Revisions copies the manuscript to the `Revisions` folder in your user folder, which can take a minute. When TeX Live has finished installing, click **Build PDF** to see the PDF beside the text.

## Updating

Run the line from step 3 again in a new PowerShell window. It replaces Revisions with the latest version and closes the old one. Open Revisions again afterwards.

## If something goes wrong

- **The installer stops with red text that starts "Revisions was not installed".** The rest of that line says why. Nothing was changed, and you can run the line again.
- **Revisions asks you to install Git or LaTeX.** Finish steps 1 and 2, then click **Check again**. If it still says they are missing, quit Revisions by closing its taskbar window, and open it again.
