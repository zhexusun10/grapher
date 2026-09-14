// Independent behavioral checks; pass the published catalog directory as argv[2].
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = resolve(process.argv[2]);
const {parseCatalog} = await import(pathToFileURL(resolve(root, 'src/csv.mjs')));
const {searchCatalog} = await import(pathToFileURL(resolve(root, 'src/search.mjs')));
const checks = [];
function check(name, run) { try { run(); checks.push({name,passed:true}); } catch(error) { checks.push({name,passed:false,error:error.message}); } }
const csv = 'id,name,price\r\nx,"Tea, green",0\r\ny,"The ""Large"" Cup",8\r\nz,tea black,12\r\n';
const expected = [{id:'x',name:'Tea, green',price:0},{id:'y',name:'The "Large" Cup',price:8},{id:'z',name:'tea black',price:12}];
check('quoted commas, escaped quotes, CRLF and typed rows',()=>assert.deepEqual(parseCatalog(csv),expected));
check('default options include zero and all finite catalog prices',()=>assert.deepEqual(searchCatalog(parseCatalog(csv)),expected));
check('case-insensitive substring query with inclusive bounds',()=>assert.deepEqual(searchCatalog(parseCatalog(csv),{query:'TEA',minPrice:0,maxPrice:12}),[expected[0],expected[2]]));
check('upper and lower bounds include exact endpoints',()=>assert.deepEqual(searchCatalog(parseCatalog(csv),{minPrice:8,maxPrice:8}),[expected[1]]));
check('order and input contents survive repeated searches',()=>{const rows=parseCatalog(csv);const before=structuredClone(rows);rows.forEach(Object.freeze);Object.freeze(rows);searchCatalog(rows,{query:'tea'});assert.deepEqual(rows,before);assert.deepEqual(searchCatalog(rows),expected);});
check('empty CSV composes with default search',()=>assert.deepEqual(searchCatalog(parseCatalog('')),[]));
check('malformed column counts and unterminated quoted field reject',()=>{for(const row of ['a,b','a,b,2,extra','a,"unfinished,2'])assert.throws(()=>parseCatalog('id,name,price\n'+row));});
check('negative and non-finite prices reject',()=>{for(const price of ['-1','Infinity','NaN','1e999'])assert.throws(()=>parseCatalog('id,name,price\na,b,'+price));});
check('invalid bounds reject while explicit Infinity remains valid',()=>{assert.throws(()=>searchCatalog(expected,{minPrice:9,maxPrice:8}));assert.throws(()=>searchCatalog(expected,{minPrice:NaN}));assert.deepEqual(searchCatalog(expected,{maxPrice:Infinity}),expected);});
console.log(JSON.stringify({checks,passed:checks.filter(x=>x.passed).length,total:checks.length},null,2));
if(checks.some(x=>!x.passed))process.exitCode=1;
