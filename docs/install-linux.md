# Install Revisions on Linux

Revisions lets you edit a LaTeX manuscript that a co-author shares with you on GitHub. These steps take a Linux computer to an open manuscript. You need a GitHub account, an internet connection, a 64-bit Intel, AMD, or Arm processor, and several gigabytes of free disk space for LaTeX.

Revisions needs two free programs besides itself:

- **Git** fetches the manuscript from GitHub and sends your changes back.
- **LaTeX** turns the manuscript into a PDF. On Linux it comes as **TeX Live**, together with a build tool called `latexmk`.

On Linux, every step uses a terminal. Open one from your applications menu; it is usually called Terminal.

## 1. Install Git and TeX Live

Install both with your system's package manager. It asks for your password.

On Ubuntu or Debian:

```sh
sudo apt install git texlive-full latexmk
```

On Fedora:

```sh
sudo dnf install git texlive-scheme-full latexmk
```

`texlive-full` and `texlive-scheme-full` are the complete TeX Live, several gigabytes, so the download can take a while. TeX Live's own documentation describes the complete installation as more than 7 GB. For other systems, see [git-scm.com/download/linux](https://git-scm.com/download/linux) and [tug.org/texlive](https://tug.org/texlive/).

## 2. Install Revisions

Paste this line into the terminal and press Enter. It needs no password.

```sh
curl -fsSL https://github.com/ryan-ressmeyer/revisions/releases/latest/download/install.sh | sh
```

If your system has no `curl`, use `wget -qO- <the same address> | sh` instead.

The installer puts Revisions in `~/.local/bin` and adds it to your applications menu. Its last lines say whether Git and LaTeX were found. To read what it does before you run it, open [the script](https://github.com/ryan-ressmeyer/revisions/releases/latest/download/install.sh) in your browser.

## 3. Open Revisions

Open **Revisions** from your applications menu, or run `~/.local/bin/revisions` in a terminal. Your browser opens a Revisions tab.

Revisions has no window of its own. It runs in the background and shows itself in the browser. Opening it again brings back the browser tab. It stops when you log out.

## 4. Sign in with GitHub

1. Click **Sign in with GitHub**. Revisions shows a one-time code.
2. Click **Copy code**, then **Open GitHub in a new tab**.
3. On GitHub, sign in if asked, paste the code, and click **Continue**. Then click **Authorize**.
4. Go back to the Revisions tab. It moves on by itself once GitHub confirms the code.

If you do not have a GitHub account, create one at [github.com/signup](https://github.com/signup) first, and send your user name to your co-author so they can give you access to the manuscript.

## 5. Open the manuscript

1. Copy the GitHub link your co-author sent you.
2. Paste it into the box under **Open a manuscript** and click **Open**.

The first time, Revisions copies the manuscript to `~/Revisions`, which can take a minute. Click **Build PDF** to see the PDF beside the text.

## Updating

Run the line from step 2 again. It replaces Revisions with the latest version and stops a copy opened from the applications menu. Open Revisions again afterwards.
