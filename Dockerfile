FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip fonts-dejavu-core fonts-noto-core tar tini && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir --break-system-packages faster-whisper
WORKDIR /app
COPY . .
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
VOLUME /data
EXPOSE 3000
ENTRYPOINT ["tini","--"]
CMD ["node","server.js"]
