# Run with --network host: the device replies to UDP 8888 and HomeKit needs mDNS on the LAN.
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs ./
ENV BIND=0.0.0.0
VOLUME /app/persist
USER node
CMD ["node", "server.mjs"]
