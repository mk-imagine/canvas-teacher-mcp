# Use Node 20 as the base image (full version for native build tools)
FROM node:20

# Set the working directory
WORKDIR /app

# Copy package files and patches for dependency installation
COPY package*.json tsconfig.base.json ./
COPY patches/ ./patches/
COPY packages/ ./packages/

# Install dependencies and build the project
RUN npm install && npm run build

# Set environment to production
ENV NODE_ENV=production

# The command to run the teacher package index.js
# --secure-heap is passed as an argument
ENTRYPOINT ["node", "--secure-heap=65536", "/app/packages/teacher/dist/index.js"]
