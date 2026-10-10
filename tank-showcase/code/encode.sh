#!/bin/bash
# Encode rendered PNG frames + generated audio into the final MP4.
set -e
cd /workspace/tank_video
ffmpeg -y -loglevel error -framerate 24 -start_number 1 -i frames/f_%04d.png -i audio.wav \
  -vf "scale=1280:720:flags=lanczos,colorbalance=rs=-0.03:bs=0.04:rh=0.03:bh=-0.03,vignette=PI/5,noise=alls=5:allf=t,fade=t=in:st=0:d=0.4,fade=t=out:st=28.6:d=1.4,format=yuv420p" \
  -c:v libx264 -preset slow -crf 18 -profile:v high -movflags +faststart \
  -c:a aac -b:a 192k -shortest tank_showcase.mp4
