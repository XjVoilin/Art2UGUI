const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../PS2UGUI_Export.jsx'),'utf8');
const entryPath='/UserData/Art2UGUI/Photoshop24/RenameEvent.jsx';
let nextId=1;
const leaf=(name,extra={})=>({id:nextId++,name,typename:'ArtLayer',visible:true,...extra});
const group=(name,layers,extra={})=>({id:nextId++,name,typename:'LayerSet',visible:true,layers,...extra});
function run(layers,active,options={}){
 const doc={typename:'Document',layers,activeLayer:active},alerts=[],registrations=[];let snapshots=0,mainReads=0;const scriptFiles=new Map(options.scriptFiles||[]),folders=new Set(['/','/UserData','/Scripts']);
 const jsonLayer=l=>({id:l.id,name:l.name,visible:l.visible,type:l.typename==='LayerSet'?'layerSection':l.kind==='TEXT'?'textLayer':'layer',
  ...(l.layers?{layers:l.layers.map(jsonLayer)}:{})});
 const snapshotJson=JSON.stringify({layers:layers.map(jsonLayer)});
 function freeze(parent){const children=parent.layers;for(const l of children){l.parent=parent;if(l.layers)freeze(l);Object.freeze(l);}Object.freeze(children);
  if(options.forbidDOMTraversal)Object.defineProperty(parent,'layers',{get(){throw new Error('Per-layer DOM traversal is forbidden');}});
 }
 freeze(doc);Object.freeze(doc);
 const own='/Scripts/PS2UGUI_Export.jsx';
 const notifiers=(options.paths||[]).map(p=>({eventFile:{fsName:p},remove(){notifiers.splice(notifiers.indexOf(this),1);}}));
 notifiers.add=(event,file,eventClass)=>{registrations.push([event,file.fsName,eventClass]);notifiers.push({eventFile:file,remove(){notifiers.splice(notifiers.indexOf(this),1);}});};
 const app={documents:options.noDoc||options.manual?[]:[doc],activeDocument:doc,notifiers,notifiersEnabled:options.enabled||false,version:'24.3.0'};
 class Descriptor{
  constructor(data){this.data=data;}
  hasKey(key){return Object.hasOwn(this.data,key);}
  getType(key){return typeof this.data[key]==='object'?'object':'scalar';}
  getObjectValue(key){return new Descriptor(this.data[key]);}
  getString(key){return this.data[key];}
 }
 const args=options.manual?[]:[new Descriptor(options.event||{'T   ':{'Nm  ':active.name}}),options.eventId||'setd'];
 class Control{
  constructor(type,text=''){this.type=type;this.text=text;this.children=[];this.graphics={font:{name:'Tahoma'}};this.preferredSize={};this.layout={layout(){}};}
  add(type,bounds,text){const c=new Control(type,text);this.children.push(c);return c;}
  show(){const render=c=>c.children.length?c.children.map(render).join(c.orientation==='row'?'':'\n'):c.text;
   alerts.push(render(this));return 1;}
 }
 class Folder{constructor(p){this.fsName=String(p);}get exists(){return folders.has(this.fsName);}get parent(){return new Folder(path.posix.dirname(this.fsName));}create(){folders.add(this.fsName);return true;}toString(){return this.fsName;}}
 Folder.userData='/UserData';
 class File{constructor(p){this.fsName=p;this.error='IO failure';}get parent(){return new Folder(path.posix.dirname(this.fsName));}get exists(){return scriptFiles.has(this.fsName);}open(){return true;}close(){}write(s){scriptFiles.set(this.fsName,s);return true;}read(){if(this.fsName===own){mainReads++;return source;}return scriptFiles.get(this.fsName);}}
 vm.runInNewContext(options.entrySource||source,{app,arguments:args,$:{fileName:own},File,Folder,charIDToTypeID:x=>x,
  DescValueType:{OBJECTTYPE:'object'},LayerKind:{TEXT:'TEXT'},alert:m=>alerts.push(m),
  stringIDToTypeID:x=>x,ActionReference:class{putProperty(){}putEnumerated(){}},
  executeActionGet:()=>{snapshots++;return new Descriptor({json:snapshotJson});},
  Window:function(type,title){return new Control(type,title);},ScriptUI:{newFont:()=>({name:'Tahoma'})}});
 return {alerts,app,registrations,snapshots,scriptFiles,mainReads};
}
test('rename check reads one native snapshot and never traverses Photoshop DOM layers',()=>{
 const active=leaf('img_prop_01');const r=run([group('Panel',[group('Deep',[leaf(active.name),active])])],active,{forbidDOMTraversal:true});
 assert.equal(r.snapshots,1);assert.match(r.alerts[0],/推荐名称：img_prop_02/);
});
test('irrelevant names return before reading any document snapshot',()=>{
 for(const name of ['Common/img_prop_01','Label','bg_01']){
  const active=leaf(name);assert.equal(run([group('Panel',[active])],active,{forbidDOMTraversal:true}).snapshots,0);
 }
});
test('rename event immediately reports duplicate numbered names and their group paths',()=>{
 const a=leaf('img_prop_01'),b=leaf('img_prop_01');
 const r=run([group('Panel',[group('Reward',[a]),group('Shop',[b])])],b);
 assert.equal(r.alerts.length,1);assert.match(r.alerts[0],/命名重复/);
 assert.match(r.alerts[0],/Panel > Reward > img_prop_01/);assert.match(r.alerts[0],/Panel > Shop > img_prop_01/);
});
test('different numbers do not warn',()=>{
 const a=leaf('img_prop_03');assert.deepEqual(run([group('Panel',[leaf('img_prop_01'),leaf('img_prop_02'),a])],a).alerts,[]);
});
test('recommendation increments the repeated number and skips occupied resource numbers',()=>{
 const active=leaf('img_prop_01');
 const r=run([group('Panel',[leaf(active.name),leaf('img_prop_02'),leaf('img_Prop_03'),active])],active);
 assert.match(r.alerts[0],/推荐名称：img_prop_04/);assert.equal(active.name,'img_prop_01');
});
test('recommendation adds numbering when absent and preserves an existing trailing underscore',()=>{
 for(const [name,expected] of [['img_logo','img_logo_03'],['img_logo_','img_logo_03']]){
  const active=leaf(name);
  const r=run([group('Panel',[leaf(name),leaf('img_logo_01'),leaf('img_logo_02'),active])],active);
  assert.match(r.alerts[0],new RegExp('推荐名称：'+expected+'(?:\\n|$)'));
 }
});
test('recommendation preserves digit width and handles carry without numeric precision loss',()=>{
 for(const [name,expected] of [['btn_ok009','btn_ok010'],['img_prop_99','img_prop_100'],
  ['img_prop_0099','img_prop_0100'],['img_prop_99999999999999999999','img_prop_100000000000000000000']]){
  const active=leaf(name);const r=run([group('Panel',[leaf(name),active])],active);
  assert.ok(r.alerts[0].includes('推荐名称：'+expected+'\n'));
 }
});
test('recommendation retains functional suffixes exactly and avoids other variants of an occupied number',()=>{
 for(const suffix of ['^0.5','~%','[240x240]~^0.5','%~[240x240]^0.5']){
  const name='img_prop_01'+suffix,active=leaf(name);
  const r=run([group('Panel',[leaf(name),leaf('img_prop_02%'),active])],active);
  assert.ok(r.alerts[0].includes('推荐名称：img_prop_03'+suffix+'\n'));assert.equal(active.name,name);
 }
});
test('only visible local resources within the same panel reserve suggested numbers',()=>{
 const active=leaf('img_prop_01');const r=run([group('Panel',[leaf(active.name),active,
  leaf('img_prop_02',{visible:false}),group('#Ref',[leaf('img_prop_02')]),leaf('Common/img_prop_02'),
  leaf('img_prop_02',{kind:'TEXT'})]),group('OtherPanel',[leaf('img_prop_02')])],active);
 assert.match(r.alerts[0],/推荐名称：img_prop_02\n/);
});
test('same names in separate top-level panels do not warn',()=>{
 const a=leaf('img_ad_01');assert.equal(run([group('A',[leaf(a.name)]),group('B',[a])],a).alerts.length,0);
});
test('hidden descendants and reference subtrees are excluded while hidden panel roots work',()=>{
 const a=leaf('img_prop_01');assert.equal(run([group('Panel',[leaf(a.name,{visible:false}),group('#Ref',[leaf(a.name)]),a],{visible:false})],a).alerts.length,0);
 const b=leaf('img_prop_01');assert.equal(run([group('Panel',[leaf(b.name),b],{visible:false})],b).alerts.length,1);
});
test('renaming a hidden child does not warn',()=>{
 const a=leaf('img_prop_01',{visible:false});assert.equal(run([group('Panel',[leaf(a.name),a])],a).alerts.length,0);
});
test('top-level panel container names do not warn',()=>{
 const a=group('Panel',[],{visible:false}),b=group('panel',[],{visible:false});assert.equal(run([a,b],b).alerts.length,0);
});
test('Common resources and other nonlocal resource names never warn',()=>{
 for(const name of ['Common/img_prop_01','Common/btn_ok_01','common/img_prop_01','Other/img_prop_01']){
  const a=leaf(name);assert.equal(run([group('Panel',[leaf(name),a])],a).alerts.length,0);
 }
});
test('text, ordinary container names and other prefixes are excluded',()=>{
 for(const name of ['Label','Container','icon_01','bg_01','btn','img']){
  const a=leaf(name);assert.equal(run([group('Panel',[leaf(name),a])],a).alerts.length,0);
 }
 const a=leaf('img_01',{kind:'TEXT'});assert.equal(run([group('Panel',[leaf(a.name),a])],a).alerts.length,0);
 const b=leaf('img_01');assert.equal(run([group('Panel',[leaf(b.name,{kind:'TEXT'}),b])],b).alerts.length,0);
});
test('both button/image layers and sprite groups warn without changing the confirmed name',()=>{
 for(const name of ['btn_prop_01','img_prop_01']){
  const a=group(name,[]),b=group(name,[]);const r=run([group('Panel',[a,b])],b);
  assert.equal(r.alerts.length,1);assert.equal(b.name,name);assert.match(r.alerts[0],/名称已保留/);
 }
});
test('eligible resource names compare without case while the export prefix remains exact',()=>{
 const a=leaf('img_prop_01'),b=leaf('img_Prop_01');assert.equal(run([group('Panel',[a,b])],b).alerts.length,1);
 const c=leaf('IMG_prop_01');assert.equal(run([group('Panel',[leaf('img_prop_01'),c])],c).alerts.length,0);
});
test('opacity events, scalar Set values and unrelated events do not trigger a reminder',()=>{
 const a=leaf('img_prop_01');for(const event of [{'T   ':{opacity:50}},{'T   ':50},{}]){
  assert.equal(run([group('Panel',[leaf(a.name),a])],a,{event}).alerts.length,0);
 }
});
test('late events after document closing do not trigger a reminder',()=>{
 const a=leaf('img_prop_01');assert.equal(run([group('Panel',[a])],a,{noDoc:true}).alerts.length,0);
});
test('enable registers one native layer Set listener without disturbing other listeners',()=>{
 const r=run([],null,{manual:true,paths:['/Other.jsx']});
 assert.deepEqual(r.registrations,[['setd',entryPath,'Lyr ']]);
 assert.equal(r.app.notifiersEnabled,true);assert.equal(r.app.notifiers.length,2);
});
test('running export again keeps its listener and unrelated listeners without registering twice',()=>{
 const r=run([],null,{manual:true,paths:['/Other.jsx',entryPath],enabled:true});
 assert.equal(r.app.notifiers.length,2);assert.equal(r.registrations.length,0);assert.equal(r.app.notifiersEnabled,true);
});
test('an installed but globally disabled listener is resumed without duplication',()=>{
 const r=run([],null,{manual:true,paths:[entryPath]});assert.equal(r.app.notifiersEnabled,true);
 assert.equal(r.registrations.length,0);assert.equal(r.app.notifiers.length,1);
});
test('first export migrates the old sibling watcher without touching unrelated listeners',()=>{
 const r=run([],null,{manual:true,paths:['/Other.jsx','/Scripts/Art2UGUI_NamingWatch.jsx']});
 assert.equal(r.app.notifiers.length,2);assert.equal(r.app.notifiers[0].eventFile.fsName,'/Other.jsx');
 assert.equal(r.app.notifiers[1].eventFile.fsName,entryPath);
});

test('light entry ignores selection, unrelated sets and Common names without loading the main script',()=>{
 const bootstrap=run([],null,{manual:true});const entrySource=bootstrap.scriptFiles.get(entryPath);
 assert.ok(entrySource.length<3000);
 for(const options of [{eventId:'slct'},{event:{'T   ':{opacity:50}}}]){
  const active=leaf('img_01');const r=run([group('Panel',[active])],active,{...options,entrySource});
  assert.equal(r.mainReads,0);assert.equal(r.snapshots,0);assert.equal(r.alerts.length,0);
 }
 const active=leaf('Common/img_01');assert.equal(run([group('Panel',[active])],active,{entrySource}).mainReads,0);
});
test('light entry forwards a real rename to the main script once and retains the confirmed name',()=>{
 const entrySource=run([],null,{manual:true}).scriptFiles.get(entryPath),active=leaf('img_01');
 const r=run([group('Panel',[leaf(active.name),active])],active,{entrySource});
 assert.equal(r.mainReads,1);assert.equal(r.snapshots,1);assert.match(r.alerts[0],/推荐名称：img_02/);assert.equal(active.name,'img_01');
});
test('old registrations on the main export file are migrated to the lightweight entry',()=>{
 const r=run([],null,{manual:true,paths:['/Other.jsx','/Scripts/PS2UGUI_Export.jsx']});
 assert.equal(r.app.notifiers.length,2);assert.equal(r.app.notifiers[1].eventFile.fsName,entryPath);
});
