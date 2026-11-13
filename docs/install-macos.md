# Install Revisions on a Mac

Revisions lets you edit a LaTeX manuscript that a co-author shares with you on GitHub. These steps take a Mac with nothing extra installed to an open manuscript. You need a GitHub account, an internet connection, and about 7 GB of free disk space. Most of the time goes to one large download.

Revisions needs two free programs besides itself:

- **Git** fetches the manuscript from GitHub and sends your changes back. Apple ships it in the *command line developer tools*.
- **LaTeX** turns the manuscript into a PDF. On a Mac it comes as **MacTeX**.

## 1. Start the MacTeX download

MacTeX is a 6.4 GB download, so start it first and let it run while you do the next steps.

1. Open [tug.org/mactex/mactex-download.html](https://tug.org/mactex/mactex-download.html) in your browser.
2. Click **MacTeX.pkg**. Your browser saves it to the Downloads folder.

MacTeX 2026 needs macOS 11 (Big Sur) or later and runs on both Apple silicon and Intel Macs.

## 2. Install Revisions and Git

This step uses Terminal, the Mac's text command window. You paste one line and press Return. You need no administrator password.

1. Open Terminal. Press Command-Space, type `Terminal`, and press Return. (It is also in Applications, in the Utilities folder.)
2. Copy this line, paste it into the Terminal window, and press Return:

   ```sh
   curl -fsSL https://github.com/ryan-ressmeyer/revisions/releases/latest/download/install.sh | sh
   ```

3. Read the last lines it prints.
   - `Git: found.` means Git is ready.
   - `Git: not found.` comes with a window from macOS that offers to install the command line developer tools. Click **Install**, then **Agree** to the licence, and wait until the window says the software was installed.
   - `LaTeX: not found.` is expected until you finish step 3.

The installer puts Revisions in the Applications folder inside your home folder. To read what it does before you run it, open [the script](https://github.com/ryan-ressmeyer/revisions/releases/latest/download/install.sh) in your browser.

## 3. Install MacTeX

1. When the download from step 1 has finished, open the Downloads folder and double-click **MacTeX.pkg**.
2. Click **Continue** through the Introduction, Read Me, and License pages, and click **Agree** when asked.
3. Click **Install** and enter your Mac password when asked.

MacTeX's own page says installation takes about ten minutes on a recent Mac. If the installer reports a failure near the end, the [MacTeX download page](https://tug.org/mactex/mactex-download.html) explains the fix.

**On macOS 27 or later, update MacTeX before you build a PDF.** The Apple menu's **About This Mac** shows which version you have. Paste each of these two lines into Terminal and press Return after each. Terminal asks for your Mac password and shows nothing while you type it.

```sh
sudo /Library/TeX/texbin/tlmgr update --self
sudo /Library/TeX/texbin/tlmgr update --all
```

The MacTeX installer carries a copy of Biber, the program that builds the bibliography, that does not start on macOS 27. The update replaces it. The second line downloads every package that has changed since the installer was made, so it can take a while.

## 4. Open Revisions

Press Command-Space, type `Revisions`, and press Return. Your browser opens a Revisions tab.

If Spotlight does not find it yet, open Finder, choose **Go > Home**, open the **Applications** folder, and double-click **Revisions**.

Revisions has no window or Dock icon of its own. It runs in the background and shows itself in the browser. Opening it again brings back the browser tab. To stop it, click **Settings** in the Revisions tab, then **Quit Revisions**. It also stops when you restart or log out.

## 5. Sign in with GitHub

1. Click **Sign in with GitHub**. Revisions shows a one-time code.
2. Click **Copy code**, then **Open GitHub in a new tab**.
3. On GitHub, sign in if asked, paste the code, and click **Continue**. Then click **Authorize**.
4. Go back to the Revisions tab. It moves on by itself once GitHub confirms the code.

If you do not have a GitHub account, create one at [github.com/signup](https://github.com/signup) first, and send your user name to your co-author so they can give you access to the manuscript.

## 6. Open the manuscript

1. Copy the GitHub link your co-author sent you.
2. Paste it into the box under **Open a manuscript** and click **Open**.

The first time, Revisions copies the manuscript to the `Revisions` folder in your home folder, which can take a minute. Click **Build PDF** to see the PDF beside the text.

## Updating

When a new version is out, a line at the top of the Revisions tab says **Version X is available**, with a link to its release notes. Click **Update**. Revisions saves your work, installs the new version, and restarts, and the tab comes back on the new version by itself. **Settings** shows which version you have and offers the same button.

If the update cannot finish, Revisions says why, keeps the version you have, and shows a command to update by hand. That command is the line from step 2: paste it into Terminal and press Return. It replaces Revisions with the latest version and stops the old one. Open Revisions again afterwards.

Version 0.1.0 has no Update button. To update from it, run the line from step 2 once.

## If something goes wrong

- **"Revisions was not installed: …"** The line after the colon says why. Nothing was changed, and you can run the line again.
- **macOS says Revisions "cannot be opened" or "is damaged".** This should not happen with the installer above, which downloads in a way macOS does not block. If it does, open **System Settings > Privacy & Security**, scroll down, click **Open Anyway** next to the message about Revisions, and confirm with **Open**.
- **Revisions asks you to install Git or LaTeX.** Finish steps 2 and 3, then click **Check again**.
- **The PDF build fails and its log says `extracting arm64 binary with lipo failed`.** On an Intel Mac the log says `x86_64` where this says `arm64`. MacTeX needs the update at the end of step 3. Run the two lines there, then click **Build PDF** again.
