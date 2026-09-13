/* Execute native message parsing/rendering. No model or alternate tokenizer. */
#define Q36_SERVER_TEST
#define Q36_SERVER_TEST_NO_MAIN
#include "q36_server.c"

static void emit_image(buf *result, size_t offset, const uint8_t *encoded,
                       size_t bytes, const char *marker, size_t index) {
    if (index) buf_putc(result, ',');
    buf_printf(result, "{\"offset\":%zu,\"bytes\":%zu,\"marker\":", offset, bytes);
    json_escape(result, marker);
    buf_puts(result, ",\"hex\":\"");
    uint32_t checksum = 2166136261u;
    for (size_t j = 0; j < bytes; j++) {
        checksum = (checksum ^ encoded[j]) * 16777619u;
        if (j < 256) buf_printf(result, "%02x", encoded[j]);
    }
    buf_printf(result, "\",\"checksum\":%u}", checksum);
}

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    buf input = {0}, result = {0};
    char chunk[8192];
    size_t n;
    while ((n = fread(chunk, 1, sizeof(chunk), stdin)) != 0) {
        if (input.len + n > 65u * 1024u * 1024u) return 3;
        buf_append(&input, chunk, n);
    }
    const char *p = input.ptr ? input.ptr : "";
    chat_msgs msgs = {0};
#ifndef DSTUDIO_Q36_NEXT_REVIEW
    http_images images = {0};
#endif
    char *content = NULL, *rendered = NULL;
    bool accepted;
    if (!strcmp(argv[1], "messages")) {
        accepted = parse_messages(&p, &msgs);
#ifndef DSTUDIO_Q36_NEXT_REVIEW
        if (accepted) rendered = render_qwen_chat_prompt_text_images(&msgs, NULL, NULL, Q36_THINK_NONE, true, &images);
#endif
    } else if (!strcmp(argv[1], "content")) {
        accepted = json_content(&p, &content);
    } else if (!strcmp(argv[1], "anthropic")) {
        accepted = parse_anthropic_messages(&p, &msgs);
#ifdef DSTUDIO_Q36_NEXT_REVIEW
    } else if (!strcmp(argv[1], "responses")) {
        accepted = parse_responses_input(&p, &msgs);
#endif
    } else return 4;
#ifdef DSTUDIO_Q36_NEXT_REVIEW
    if (accepted && strcmp(argv[1], "content"))
        rendered = render_chat_prompt_text_profile(&msgs, NULL, NULL, Q36_THINK_NONE, false, true);
#endif
    buf_printf(&result, "{\"accepted\":%s,\"rendered\":", accepted ? "true" : "false");
    json_escape(&result, rendered ? rendered : "");
    buf_puts(&result, ",\"content\":");
    json_escape(&result, content ? content : "");
    buf_puts(&result, ",\"messages\":[");
    for (int i = 0; i < msgs.len; i++) {
        if (i) buf_putc(&result, ',');
        json_escape(&result, msgs.v[i].content ? msgs.v[i].content : "");
    }
    buf_puts(&result, "],\"images\":[");
#ifdef DSTUDIO_Q36_NEXT_REVIEW
    size_t index = 0;
    for (int m = 0; m < msgs.len; m++) for (size_t i = 0; i < msgs.v[m].images.len; i++) {
        const server_image_input *image = &msgs.v[m].images.v[i];
        const char *at = rendered ? strstr(rendered, image->marker) : NULL;
        emit_image(&result, at ? (size_t)(at - rendered) : SIZE_MAX,
                   image->encoded, image->encoded_len, image->marker, index++);
    }
#else
    for (size_t i = 0; i < images.len; i++) {
        emit_image(&result, images.v[i].offset, images.v[i].encoded, images.v[i].bytes,
                   "<|vision_start|><|image_pad|><|vision_end|>", i);
    }
#endif
    buf_printf(&result, "],\"layout\":{\"request\":%zu,\"message\":%zu,\"image\":%zu}}\n",
               sizeof(request), sizeof(chat_msg),
#ifdef DSTUDIO_Q36_NEXT_REVIEW
               sizeof(server_image_input));
#else
               sizeof(http_image));
#endif
    fputs(result.ptr, stdout);
    free(content); free(rendered); chat_msgs_free(&msgs);
#ifndef DSTUDIO_Q36_NEXT_REVIEW
    free(images.v); /* Renderer positions borrow the message's encoded bytes. */
#endif
    buf_free(&input); buf_free(&result);
    return 0;
}
