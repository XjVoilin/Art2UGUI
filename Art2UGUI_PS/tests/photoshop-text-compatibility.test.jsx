// Read-only business text regression; does not render PNGs or write beside the PSD.
(function () {
    var project=new File($.fileName).parent.parent;
    var output=new Folder(project.parent+'/.tmp/photoshop-text-compatibility-test');
    if(!output.exists)output.create();
    var report=[],alerts=[];
    function alert(message){alerts.push(message);}
    function read(file){file.encoding='UTF-8';if(!file.open('r'))throw new Error('Cannot read '+file.fsName);try{return file.read();}finally{file.close();}}
    function assert(ok,message){if(!ok)throw new Error(message);}
    try{
        var doc=app.activeDocument;
        assert(doc.name==='\u56fe\u9274.psd','Open the collection PSD before running this check');
        var history=doc.historyStates.length,active=doc.activeLayer,saved=doc.saved;
        var source=read(new File(project+'/PS2UGUI_Export.jsx'))
            .replace('    ensureNamingWatch();','    // No event registration during text regression.')
            .replace('var exportOptions = selectExportOptions();','var exportOptions = {group:doc.layerSets.getByName("\\u56fe\\u9274\\u754c\\u9762"),padding:2};')
            .replace('var outputDir = docPath + "/" + exportName;','var outputDir = "'+output.fullName+'/" + exportName;')
            .replace('if (exportLayerPNG(item, outputDir + "/" + item.fileName + ".png")) pngCount++;','pngCount++; // This regression checks text JSON only.')
            .replace('new Folder(outputDir).execute()','true');
        eval(source);
        assert(alerts.length>0,'Missing export result');
        assert(alerts[alerts.length-1].indexOf('\u5bfc\u51fa\u5931\u8d25')<0,alerts[alerts.length-1]);
        var data=eval('('+read(new File(output+'/\u56fe\u9274\u754c\u9762/\u56fe\u9274\u754c\u9762_ui_data.json'))+')');
        var found=false,normal=false;
        for(var i=0;i<data.layers.length;i++){
            var node=data.layers[i];
            if(node.type!=='text')continue;
            if(node.name==='\u9650\u5b9a'){assert(node.textAlignment==='center','Unreadable alignment must use the requested center fallback');found=true;}
            if(node.text==='\u5ae6\u9e45'){assert(node.textAlignment==='center','Normal centered alignment changed');normal=true;}
        }
        assert(found&&normal,'Missing business text checks');
        assert(alerts[alerts.length-1].indexOf('\u9ed8\u8ba4\u5c45\u4e2d')>=0,'Fallback warning missing');
        assert(history===doc.historyStates.length&&active===doc.activeLayer&&saved===doc.saved,'Source PSD changed');
        report.push('PASS: actual unreadable text exports centered; normal centered text preserved; warning shown; original PSD unchanged');
        report.push('PASS: Photoshop '+app.version+'; text JSON only, PNG rendering intentionally excluded');
    }catch(e){report.push('FAIL '+e.number+' '+e.message+' line '+e.line);}
    var file=new File(output+'/report.txt');file.encoding='UTF-8';file.open('w');file.write(report.join('\n'));file.close();return report.join('\n');
})();
