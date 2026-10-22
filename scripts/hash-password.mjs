import { hashPassword } from '../lib/auth.mjs';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

// Passwords are read from stdin, never from command-line arguments or shell history.
if (process.argv.length > 2) {
  console.error('Do not pass passwords as arguments. Run npm run password and enter the password at the prompt.');
  process.exitCode = 1;
} else {
  try {
    let password;
    if (process.stdin.isTTY) {
      let muted = false;
      const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
      const terminal = createInterface({ input: process.stdin, output, terminal: true });
      const answer = terminal.question('Pilot password (at least 12 characters; hidden): ');
      muted = true;
      password = await answer;
      terminal.close();
      process.stdout.write('\n');
    } else {
      const chunks = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > 4096) throw new Error('Password input is too long.');
        chunks.push(chunk);
      }
      password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
    }
    console.log(await hashPassword(password));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
