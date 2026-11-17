// Business text JSON regression. Reads the four panel groups without PNG rendering.
(function () {
    var project=new File($.fileName).parent.parent;
    var output=new Folder(project.parent+'/.tmp/photoshop-text-strokes-test');
    if(!output.exists)output.create();
    var previous=app.documents.length?app.activeDocument:null,dialogs=app.displayDialogs;
    var doc=null,opened=false,report=[],messages=[];
    function alert(message){messages.push(message);}
    function read(file){file.encoding='UTF-8';if(!file.open('r'))throw new Error('Cannot read '+file.fsName);try{return file.read();}finally{file.close();}}
    function assert(ok,message){if(!ok)throw new Error(message);}
    try{
        var file=new File('E:/SoftData/Feishu/GooseMarketSort_PSD/\u5173\u5361UI(\u6298\u6263\u89c6\u89c9\u98ce) \u4ea4\u4e922.psd');
        for(var n=0;n<app.documents.length;n++){
            var existingPath;
            try{existingPath=app.documents[n].fullName.fsName;}catch(unsavedDocument){continue;}
            if(existingPath.toLowerCase()===file.fsName.toLowerCase()){doc=app.documents[n];break;}
        }
        app.displayDialogs=DialogModes.NO;
        if(!doc){doc=app.open(file);opened=true;}
        app.activeDocument=doc;
        var history=doc.historyStates.length,active=doc.activeLayer,saved=doc.saved;
        var exporter=read(new File(project+'/PS2UGUI_Export.jsx'))
            .replace('    ensureNamingWatch();','    // No event registration in regression.')
            .replace('var exportOptions = selectExportOptions();','var exportOptions = {group:doc.layerSets.getByName(panelName),padding:1};')
            .replace('var outputDir = docPath + "/" + exportName;','var outputDir = "'+output.fullName+'/" + exportName;')
            .replace('if (exportLayerPNG(item, outputDir + "/" + item.fileName + ".png")) pngCount++;','pngCount++; // Text JSON regression, no PNG rendering.')
            .replace('new Folder(outputDir).execute()','true');
        var ref=new ActionReference();ref.putProperty(charIDToTypeID('Prpr'),stringIDToTypeID('json'));ref.putEnumerated(charIDToTypeID('Dcmn'),charIDToTypeID('Ordn'),charIDToTypeID('Trgt'));
        var snapshot=eval('('+executeActionGet(ref).getString(stringIDToTypeID('json'))+')');
        var ids={};
        function index(nodes,path){for(var i=0;i<nodes.length;i++){var node=nodes[i],full=path?path+'/'+node.name:node.name;if(node.type==='textLayer')ids['$'+full]=node.id;if(node.layers)index(node.layers,full);}}
        index(snapshot.layers,'');
        var names=['UIVictoryWindow','UIDefeatWindow','UITrayFullReviveWindow','UITimeoutReviveWindow'];
        var enabled=0,disabled=0;
        for(var k=0;k<names.length;k++){
            var panelName=names[k];eval(exporter);
            assert(messages[messages.length-1].indexOf('\u5bfc\u51fa\u5931\u8d25')<0,messages[messages.length-1]);
            var data=eval('('+read(new File(output+'/'+panelName+'/'+panelName+'_ui_data.json'))+')');
            for(var i=0;i<data.layers.length;i++){
                var node=data.layers[i];if(node.type!=='text')continue;
                var path=panelName+'/'+(node.groupPath?node.groupPath+'/':'')+node.name;
                var r=new ActionReference();r.putIdentifier(charIDToTypeID('Lyr '),ids['$'+path]);
                var descriptor=executeActionGet(r);
                if(!descriptor.hasKey(stringIDToTypeID('layerEffects')))continue;
                var fx=descriptor.getObjectValue(stringIDToTypeID('layerEffects'));
                if(!fx.hasKey(stringIDToTypeID('frameFX')))continue;
                var stroke=fx.getObjectValue(stringIDToTypeID('frameFX'));
                var visible=(!descriptor.hasKey(stringIDToTypeID('layerFXVisible'))||descriptor.getBoolean(stringIDToTypeID('layerFXVisible')))&&
                    (!stroke.hasKey(stringIDToTypeID('enabled'))||stroke.getBoolean(stringIDToTypeID('enabled')));
                if(visible){assert(node.strokeWidth===stroke.getUnitDoubleValue(stringIDToTypeID('size')),'Enabled stroke width changed: '+path);enabled++;}
                else{assert(typeof node.strokeWidth==='undefined'&&typeof node.strokeColor==='undefined','Disabled stroke exported: '+path);disabled++;}
            }
            report.push('PASS: '+panelName);
        }
        assert(enabled>0&&disabled>0,'Business PSD must exercise both stroke states');
        assert(history===doc.historyStates.length&&active===doc.activeLayer&&saved===doc.saved,'Source PSD changed');
        report.push('PASS: '+enabled+' enabled strokes preserved; '+disabled+' disabled strokes omitted; source unchanged');
    }catch(e){report.push('FAIL '+e.number+' '+e.message+' line '+e.line);}
    finally{if(opened&&doc)doc.close(SaveOptions.DONOTSAVECHANGES);if(previous)app.activeDocument=previous;app.displayDialogs=dialogs;}
    var reportFile=new File(output+'/report.txt');reportFile.encoding='UTF-8';reportFile.open('w');reportFile.write(report.join('\n'));reportFile.close();return report.join('\n');
})();
