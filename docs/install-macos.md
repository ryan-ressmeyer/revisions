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

Run the line from step 2 again. It replaces Revisions with the latest version and stops the old one. Open Revisions again afterwards.

## If something goes wrong

- **"Revisions was not installed: …"** The line after the colon says why. Nothing was changed, and you can run the line again.
- **macOS says Revisions "cannot be opened" or "is damaged".** This should not happen with the installer above, which downloads in a way macOS does not block. If it does, open **System Settings > Privacy & Security**, scroll down, click **Open Anyway** next to the message about Revisions, and confirm with **Open**.
- **Revisions asks you to install Git or LaTeX.** Finish steps 2 and 3, then click **Check again**.
