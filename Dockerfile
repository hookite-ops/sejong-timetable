FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json server.js ./
COPY public ./public
# 로컬 폴백 저장 폴더 (Cloud Run에서는 Firestore를 쓰므로 비어 있어도 됨)
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
CMD ["node", "server.js"]
