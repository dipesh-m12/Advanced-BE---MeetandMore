# Use a minimal Node.js base image
FROM node:18-alpine

# Set the working directory in the container
WORKDIR /app

# Copy only package.json and lock file first for efficient caching
COPY package*.json ./

# Install only production dependencies
RUN npm install --production

# Copy the rest of your app
COPY . .

# Expose the port your app listens on
EXPOSE 5000

# Start the application
CMD ["npm", "start"]
