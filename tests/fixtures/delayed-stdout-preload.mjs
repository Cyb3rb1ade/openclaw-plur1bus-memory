const originalWrite = process.stdout.write.bind(process.stdout);

process.stdout.write = (...args) => {
  setTimeout(() => {
    originalWrite(...args);
  }, 25);
  return false;
};
