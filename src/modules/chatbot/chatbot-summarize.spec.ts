import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import axios from 'axios';
import { ChatbotService } from './chatbot.service';

jest.mock('axios');
const mockedPost = axios.post as jest.MockedFunction<typeof axios.post>;

/**
 * The summary this returns is published verbatim — on the post and as the
 * post's line in llms.txt — so the failure modes matter as much as the happy
 * path: nothing that is not a real summary may be handed back as one.
 */
describe('ChatbotService.summarize', () => {
  const build = () =>
    new ChatbotService({ get: () => undefined } as never, {} as never);

  const ARTICLE = '<p>Collectors in India buy figures to display them.</p>';

  beforeEach(() => {
    mockedPost.mockReset();
    delete process.env.CHATBOT_API_URL;
  });

  it('returns the sidecar summary, trimmed', async () => {
    mockedPost.mockResolvedValue({
      data: { summary: '  Indian collectors display their figures.  ' },
    } as never);

    await expect(build().summarize({ title: 'T', content: ARTICLE })).resolves.toBe(
      'Indian collectors display their figures.',
    );
  });

  it('sends the post HTML as stored, with the word limit', async () => {
    mockedPost.mockResolvedValue({ data: { summary: 'ok' } } as never);

    await build().summarize({ title: 'Collecting', content: ARTICLE, maxWords: 45 });

    const [url, body] = mockedPost.mock.calls[0];
    expect(url).toContain('/summarize');
    // Stripping HTML is the sidecar's job, in one place, so the model reads
    // exactly the text a reader sees.
    expect(body).toMatchObject({
      title: 'Collecting',
      content: ARTICLE,
      max_words: 45,
    });
  });

  it('passes "not enough content" back as a 400, not an outage', async () => {
    mockedPost.mockRejectedValue({
      message: 'Request failed',
      response: { status: 400, data: { detail: 'There is not enough content.' } },
    });

    await expect(
      build().summarize({ content: '<p>Hi.</p>' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reports a sidecar failure instead of returning prose as the summary', async () => {
    // sendMessage degrades to an apology string because a customer is waiting.
    // Here that string would be SAVED as the post's aiSummary and served to
    // crawlers, so this path must throw.
    mockedPost.mockRejectedValue({ message: 'connect ECONNREFUSED' });

    await expect(
      build().summarize({ content: ARTICLE }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('treats an empty summary as a failure', async () => {
    mockedPost.mockResolvedValue({ data: { summary: '   ' } } as never);

    await expect(
      build().summarize({ content: ARTICLE }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('honours CHATBOT_API_URL when the sidecar is not local', async () => {
    process.env.CHATBOT_API_URL = 'http://sidecar.internal:5005';
    mockedPost.mockResolvedValue({ data: { summary: 'ok' } } as never);

    await build().summarize({ content: ARTICLE });

    expect(mockedPost.mock.calls[0][0]).toBe(
      'http://sidecar.internal:5005/summarize',
    );
  });
});

describe('ChatbotService.aiWrite', () => {
  const build = () =>
    new ChatbotService({ get: () => undefined } as never, {} as never);

  const ARTICLE = '<p>Collectors in India buy figures to display them.</p>';

  beforeEach(() => {
    mockedPost.mockReset();
    delete process.env.CHATBOT_API_URL;
  });

  it('passes the requested kind through to the sidecar', async () => {
    mockedPost.mockResolvedValue({ data: { text: 'A description.' } } as never);

    await build().aiWrite({ content: ARTICLE, kind: 'meta_description' });

    expect(mockedPost.mock.calls[0][1]).toMatchObject({ kind: 'meta_description' });
  });

  it('defaults to the summary, which is all this used to do', async () => {
    mockedPost.mockResolvedValue({ data: { text: 'A summary.' } } as never);

    await build().aiWrite({ content: ARTICLE });

    expect(mockedPost.mock.calls[0][1]).toMatchObject({ kind: 'summary' });
  });

  it('returns keywords as a list of strings', async () => {
    mockedPost.mockResolvedValue({
      data: { text: 'a, b', keywords: ['a', 'b', 42] },
    } as never);

    const result = await build().aiWrite({ content: ARTICLE, kind: 'keywords' });

    expect(result.keywords).toEqual(['a', 'b']);
  });

  it('reads the old `summary` field from a sidecar that has not redeployed', async () => {
    // The API and the Python sidecar ship together but reload separately;
    // one request landing on the old one must not look like a failure.
    mockedPost.mockResolvedValue({ data: { summary: 'Old shape.' } } as never);

    await expect(build().aiWrite({ content: ARTICLE })).resolves.toMatchObject({
      text: 'Old shape.',
      keywords: [],
    });
  });

  it('names the field in the error an admin sees', async () => {
    mockedPost.mockRejectedValue({ message: 'connect ECONNREFUSED' });

    await expect(
      build().aiWrite({ content: ARTICLE, kind: 'meta_description' }),
    ).rejects.toThrow(/meta description/);
  });
});
