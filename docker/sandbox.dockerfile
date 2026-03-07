FROM public.ecr.aws/lambda/nodejs:22
WORKDIR /var/task
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["node", "dist/src/Gateway.js"]
