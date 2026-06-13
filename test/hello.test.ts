import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Minimal in-memory Express app that mirrors the /hello endpoint behavior
describe('/hello endpoint', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    // Replicate the /hello route logic from src/index.ts
    app.post('/hello', (req, res) => {
      const { name } = req.body || {};

      // Missing name parameter
      if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({
          error: 'Missing or invalid "name" parameter. Please provide a valid string.',
        });
      }

      // Validate name format: only letters, spaces, hyphens, apostrophes allowed
      const nameRegex = /^[a-zA-Z\s\-']+$/;
      if (!nameRegex.test(name.trim())) {
        return res.status(400).json({
          error: 'Invalid name format. Name can only contain letters, spaces, hyphens, and apostrophes.',
        });
      }

      const greeting = `Hello, ${name.trim()}!`;
      return res.status(200).json({ message: greeting, name: name.trim() });
    });
  });

  describe('POST /hello', () => {
    it('should return a greeting for a valid name', async () => {
      const res = await request(app).post('/hello').send({ name: 'World' });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('message', 'Hello, World!');
      expect(res.body).toHaveProperty('name', 'World');
    });

    it('should handle names with leading/trailing whitespace', async () => {
      const res = await request(app).post('/hello').send({ name: '  Alice  ' });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('message', 'Hello, Alice!');
      expect(res.body).toHaveProperty('name', 'Alice');
    });

    it('should handle names with hyphens', async () => {
      const res = await request(app).post('/hello').send({ name: 'Mary-Jane' });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('message', 'Hello, Mary-Jane!');
    });

    it('should handle names with apostrophes', async () => {
      const res = await request(app).post('/hello').send({ name: "O'Brien" });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('message', "Hello, O'Brien!");
    });

    it('should return 400 when name parameter is missing', async () => {
      const res = await request(app).post('/hello').send({});
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
      expect(typeof res.body.error).toBe('string');
    });

    it('should return 400 when name is an empty string', async () => {
      const res = await request(app).post('/hello').send({ name: '' });
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    it('should return 400 when name is only whitespace', async () => {
      const res = await request(app).post('/hello').send({ name: '   ' });
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    it('should return 400 when name is not a string (number)', async () => {
      const res = await request(app).post('/hello').send({ name: 123 });
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    it('should return 400 when name contains special characters', async () => {
      const res = await request(app).post('/hello').send({ name: 'John@#$' });
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    it('should return 400 when name contains digits', async () => {
      const res = await request(app).post('/hello').send({ name: 'User123' });
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    it('should return 400 when request body is not JSON', async () => {
      const res = await request(app)
        .post('/hello')
        .set('Content-Type', 'text/plain')
        .send('not json');
      // Express json() middleware will return 400 for malformed JSON
      expect(res.status).toBe(400);
    });

    it('should return 400 when name is null', async () => {
      const res = await request(app).post('/hello').send({ name: null });
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    it('should return 400 when name is an array', async () => {
      const res = await request(app).post('/hello').send({ name: ['Alice'] });
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    it('should handle Unicode letters in name', async () => {
      const res = await request(app).post('/hello').send({ name: 'José' });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('message', 'Hello, José!');
    });

    it('should return 400 for empty request body', async () => {
      const res = await request(app).post('/hello').send();
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });
  });
});
