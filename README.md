# watch-party
watch-party

Watch Party is a web app for watching videos together in real time. One person creates a room, friends join with a code, a link or a direct invite, and everyone sees the same video at the same moment. Play, pause and seeking stay in sync, and the room has chat, reactions, a shared playlist, polls, a movie search and a library of uploaded videos.

It runs as a single Node.js server (Express and Socket.IO) with one self-contained web page as the frontend. There is no build step.

Features

Rooms

Create a room as public (listed on the home page, one click to join) or private (listed by name only; you need the room code or invite link).
Give a room a name, or use the default "NAME's room".
Join with a 6-character room code, an invite link (/room/CODE), or a direct invite from a friend.
When a room opens, red curtains part, a 3-2-1 countdown plays, and the video starts.
The host can make another person host, or remove someone (a removed person cannot rejoin that room). If the host's connection drops, the room waits 15 seconds for them to return before closing. If the host chooses "Close room", it closes for everyone at once.

Synchronised playback

Play, pause and seek are shared by everyone in the room.
Works with YouTube links and direct video files (such as .mp4).
By default only the host can pause and unpause; everyone can seek and pick videos. This is one setting in server.js (see Configuration).
Each page measures how far its video is from the room (drift). Large drift is fixed with a jump; small drift is fixed by a slight change in playback speed. The audience list shows every person's sync status and drift in milliseconds.

Things to do together

Chat and five floating emoji reactions.
A shared playlist with automatic next-video.
Polls: custom questions, or "what should we watch next" built from the playlist (the winner starts playing when the poll closes).
Movies: search a pool of about 300 movies from TMDB (typos are tolerated) and add a movie's trailer to the playlist.
Library: upload a downloaded video from your device, then play it for the room or add it to the playlist.
Friends: every browser has a permanent 6-character Friend ID. Add a friend's ID once and the host can invite them straight into the room. The friend sees an invite with a Join button, with no code to type.
Technology
Part	Choice
Server	Node.js, Express 4
Real time	Socket.IO 4 (WebSockets)
Movie data	TMDB API, Fuse.js for fuzzy search
Frontend	One HTML file with plain JavaScript, the YouTube IFrame Player API and the HTML5 video element
Storage	In memory for rooms; files on disk plus a small JSON file for the video library and the movie cache

website link for watch party: https://watch-party-wlly.onrender.com/ 