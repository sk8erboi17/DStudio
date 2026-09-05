// Synthetic public inputs only. Independent expected outputs are computed
// before inference; the model's own claims are never the correctness oracle.
export const passage=Array.from({length:16},(_,i)=>
  `Record ${String(i+1).padStart(2,'0')}: preserve the original evidence, verify the exact result, and keep unrelated details unchanged.`).join('\n');
export const source='export const version = "1.0";\n'+Array.from({length:18},(_,i)=>
  `export const item${i+1} = { id: ${i+1}, label: "Entry ${i+1}", enabled: true };`).join('\n')+'\n';
const quote='La città conserva café, numeri 17.25, simboli <tag> & "quote" e righe originali.\n'+passage;
export const cases=[
  {id:'chat-copy',surface:'chat',family:'copy',maxTokens:1000,
    prompt:`Return exactly the text between SOURCE tags, with no tags, Markdown or commentary.\n<SOURCE>\n${passage}\n</SOURCE>`,expected:passage},
  {id:'chat-edit',surface:'chat',family:'preserving-edit',maxTokens:1200,
    prompt:`Return the complete source below, changing only version "1.0" to "1.1". No fences or commentary.\n${source}`,
    expected:source.replace('"1.0"','"1.1"')},
  {id:'chat-document',surface:'chat',family:'document-extraction',maxTokens:1000,
    prompt:`Extract section B verbatim from this retrieved document. Return only that section's body.\nSection A\nObsolete draft.\nSection B\n${quote}\nSection C\nUnrelated appendix.`,expected:quote},
  {id:'chat-stream',surface:'chat',family:'streaming-copy',stream:true,maxTokens:1000,
    prompt:`Copy the SOURCE exactly; no Markdown or commentary.\nSOURCE\n${quote}\nEND SOURCE`,expected:quote},
  {id:'chat-new',surface:'chat',family:'new-answer-control',maxTokens:150,
    prompt:'Compute 19 * 23 and sort [8,3,11,2] ascending. Return only JSON with keys product and sorted.',
    expectedJson:{product:437,sorted:[2,3,8,11]}},
  {id:'chat-stop',surface:'chat',family:'stop-string',stop:['[STOP_HERE]'],maxTokens:1000,
    prompt:`Copy exactly the following text, without fences or commentary:\n${passage}\n[STOP_HERE]\nTHIS SUFFIX MUST NOT REACH THE CLIENT`,expected:passage},
  {id:'chat-tool',surface:'chat',family:'tool-boundary',maxTokens:1300,
    prompt:`Call store_note once, passing exactly the following text as body. Do not change or summarize it.\n${quote}`,
    tools:[{type:'function',function:{name:'store_note',description:'Store a note',parameters:{type:'object',properties:{body:{type:'string'}},required:['body']}}}],expectedTool:{name:'store_note',body:quote}},
  {id:'agent-copy',surface:'agent',family:'tool-write',files:{'source.js':source},output:'copy.js',expected:source,
    prompt:'Read source.js and use the write tool to create copy.js containing exactly the same bytes. Reopen it to verify. Do not modify source.js. Finish with DONE.'},
  {id:'agent-edit',surface:'agent',family:'surgical-edit',files:{'source.js':source},output:'source.js',expected:source.replace('"1.0"','"1.1"'),
    prompt:'Read source.js. Change only version "1.0" to "1.1", preserving every other byte. Reopen to verify. Finish with DONE.'},
  {id:'agent-new',surface:'agent',family:'new-code-control',files:{},output:'sum.js',
    prompt:'Create sum.js exporting function sum(values) that returns the sum of an array of numbers, with zero for an empty array. Reopen it and finish with DONE.',codeCheck:true},
  {id:'cowork-copy',surface:'cowork',family:'document-write',files:{'source.txt':quote+'\n'},output:'copy.txt',expected:quote+'\n',
    prompt:'Use read_document on source.txt, then write_document to create copy.txt with exactly the same text. Reopen copy.txt to verify. Do not modify source.txt. Finish with DONE.'},
  {id:'cowork-edit',surface:'cowork',family:'document-revision',files:{'source.txt':quote+'\n'},output:'revision.txt',expected:quote.replace('17.25','18.50')+'\n',
    prompt:'Read source.txt. Use write_document to create revision.txt, changing only 17.25 to 18.50 and preserving all other text. Reopen revision.txt to verify. Do not modify source.txt. Finish with DONE.'},
  {id:'cowork-new',surface:'cowork',family:'new-document-control',files:{},output:'answer.txt',expected:'437\n',
    prompt:'Calculate 19 times 23. Use write_document to create answer.txt containing only the integer result and a final newline, no title or commentary. Reopen it to verify. Finish with DONE.'},
];

export function checkChat(test,answer,tools=[]) {
  if(test.expectedJson) {
    try { const obj=JSON.parse(answer);return obj.product===437&&JSON.stringify(obj.sorted)==='[2,3,8,11]'; }catch{return false;}
  }
  if(test.expectedTool) {
    try{return tools.length===1&&tools[0].function.name===test.expectedTool.name&&
      JSON.parse(tools[0].function.arguments).body===test.expectedTool.body;}catch{return false;}
  }
  return answer.trimEnd()===test.expected.trimEnd();
}
