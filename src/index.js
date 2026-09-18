import { BareWeb, createApp } from './app.js';
import { Router } from './router.js';
import { Trie } from './trie.js';
import { BareWebRequest, decorateRequest, parseQuery, compileTrustProxy, DEFAULT_BODY_LIMIT } from './request.js';
import { BareWebResponse, decorateResponse, MIME_TYPES } from './response.js';
import { runPipeline, defaultErrorHandler, cors, serveStatic, json, urlencoded } from './middleware.js';

// Attach static helpers to factory function (Express-like ergonomics)
createApp.BareWeb = BareWeb;
createApp.Router = Router;
createApp.Trie = Trie;
createApp.cors = cors;
createApp.serveStatic = serveStatic;
createApp.json = json;
createApp.urlencoded = urlencoded;

export {
  BareWeb,
  createApp,
  Router,
  Trie,
  BareWebRequest,
  decorateRequest,
  parseQuery,
  compileTrustProxy,
  DEFAULT_BODY_LIMIT,
  BareWebResponse,
  decorateResponse,
  MIME_TYPES,
  runPipeline,
  defaultErrorHandler,
  cors,
  serveStatic,
  json,
  urlencoded
};

// Default export for convenience (similar to `import express from 'express'`)
export default createApp;
