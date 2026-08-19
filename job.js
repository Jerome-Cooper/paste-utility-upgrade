import {fromTriangles, applyToPoint, applyToPoints} from 'transformation-matrix';
import {importGerberSet, sortPadsRasterOrder, tagTightPitchPads, planPadDispense} from './gerberImport.js';

class Point {
    constructor(x, y, z, dispenseDegrees) {

        //these are the raw positions from the gerber import
        this.x = x;
        this.y = y;
        this.z = z;

        // per-point dispense override (e.g. from gerber pad-size scaling / multi-dot
        // patterns); null means "use the job's global Dispense Degrees setting"
        this.dispenseDegrees = dispenseDegrees ?? null;

        // these are any calibrated positions as a result from fid cal
        this.calX = null;
        this.calY = null;

        // this is where on the canvas the dot was drawn for this point
        this.canvasX = null;
        this.canvasY = null;

        // this is the dom object for the little card in the point list
        this.docElement = null;
    }

    toArray() {
        return [this.x, this.y, this.z];
    }

    static fromArray(arr) {
        return new Point(arr[0], arr[1], arr[2]);
    }

}

class Fiducial extends Point {
    constructor(x, y, z, searchX, searchY) {
        super(x, y, z)
        this.searchX = searchX;
        this.searchY = searchY;
    }

}

export class Job {
    constructor(lumen, toast) {

        this.placements = [];
        this.fiducials = [];

        this.dispenseDegrees = 30;
        this.motionSpeed = 35000;
        this.extruderSpeed = 100000;
        this.vacuumPressure = 100; // air assist, as a percentage (0-100)
        this.preGcode = "";
        this.postGcode = "";
        this.invertDispense = false;
        this.isRunning = false;
        this.lumen = lumen;
        this.toast = toast;

        this.jobCanvas = document.getElementById('pointViz');

        this.clickedFidBuffer = [];
    }

    // this does a few things
    // it takes all the points and fids in a job, and draws them on the canvas
    // it also saves all the drawn positions to the point and fid objects for easier click detection
    //
    drawJobToCanvas(){


        // const rect = this.jobCanvas.getBoundingClientRect();
        // this.jobCanvas.width = rect.width;
        // this.jobCanvas.height = rect.height;
        // this.jobCanvas.style.width = `${rect.width}px`;
        // this.jobCanvas.style.height = `${rect.height}px`;

        const ctx = this.jobCanvas.getContext("2d");

        // Find bounds of all points
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const point of this.placements) {

            minX = Math.min(minX, point.x);
            minY = Math.min(minY, point.y);
            maxX = Math.max(maxX, point.x);
            maxY = Math.max(maxY, point.y);
        }

        for (const point of this.fiducials) {
            minX = Math.min(minX, point.x);
            minY = Math.min(minY, point.y);
            maxX = Math.max(maxX, point.x);
            maxY = Math.max(maxY, point.y);
        }

        // Add a small margin to the bounds
        const margin = Math.max(maxX - minX, maxY - minY) * 0.1; // 10% margin
        minX -= margin;
        minY -= margin;
        maxX += margin;
        maxY += margin;

        const width = maxX - minX;
        const height = maxY - minY;

        // Calculate scale to fit the canvas while maintaining aspect ratio
        const scaleX = this.jobCanvas.width / width;
        const scaleY = this.jobCanvas.height / height;
        const vizScale = Math.min(scaleX, scaleY);

        // Calculate shifts to center the points
        const xShift = -minX;
        const yShift = -minY;

        // Clear canvas
        ctx.clearRect(0, 0, this.jobCanvas.width, this.jobCanvas.height);

        // Draw fid points in blue
        ctx.fillStyle = "blue";
        for (let point of this.fiducials) {

            const newX = (point.x + xShift) * vizScale;
            const newY = (point.y + yShift) * vizScale;

            point.canvasX = newX;
            point.canvasY = newY;

            ctx.beginPath();
            ctx.arc(newX, this.jobCanvas.height - newY, 2, 0, Math.PI * 2);
            ctx.fill();

        }

        // Draw paste points in red
        ctx.fillStyle = "red";
        for (let point of this.placements) {
            const newX = (point.x + xShift) * vizScale;
            const newY = (point.y + yShift) * vizScale;

            point.canvasX = newX;
            point.canvasY = newY;

            ctx.beginPath();
            ctx.arc(newX, this.jobCanvas.height - newY, 2, 0, Math.PI * 2);
            ctx.fill();
        }

    }

    // returns the closest point object to a click coordinate on the canvas
    returnClosestFidFromClickCoordinates(clickX, clickY){
        // Find the closest point within a larger threshold
        const threshold = 10.0; // 2mm threshold for easier clicking
        let closestPoint = null;
        let minDistance = Infinity;

        // Only check fid points
        for (const point of this.fiducials) {
            // console.log("checking against: ", point.canvasX, point.canvasY)
            const distance = Math.sqrt(
                Math.pow(point.canvasX - clickX, 2) +
                Math.pow(point.canvasY - clickY, 2)
            );
            if (distance < threshold && distance < minDistance) {
                minDistance = distance;
                closestPoint = point;
            }
        }

        return closestPoint;

    }

    // Imports a paste (+ optional mask) layer from whatever was selected in the
    // gerber file input - either a single zip (typical KiCad/JLCPCB/EasyEDA fab
    // output bundle) or several loose gerber files - auto-detecting which file
    // is which from the Gerber X2 %TF.FileFunction% attribute (falling back to
    // filename conventions for older exports that don't have it).
    //
    // Pads are classified from their real aperture geometry: elongated pads get
    // a line of dots, large open pads (e.g. QFN thermal pads) get a grid, and
    // pads sitting in a fine pitch row (TSOP/QFP-style) get a single dot that
    // alternates position slightly to cut bridging risk. Each dot's dispense
    // volume is scaled off a 30-degree-for-a-0402-pad baseline. See
    // gerberImport.js for the tunable thresholds.
    async loadGerberFiles(fileList){
        const {pastePads, maskFlashes, warnings} = await importGerberSet(fileList);

        if (warnings.length) console.warn('Gerber import warnings:', warnings);

        const sortedPads = sortPadsRasterOrder(pastePads);
        const taggedPads = tagTightPitchPads(sortedPads);

        // Alternate the stagger direction while we're walking through a run of
        // tight-pitch pads, resetting once we leave that run.
        let staggerToggle = 1;
        for (const pad of taggedPads){
            const sign = pad.tightPitch ? staggerToggle : 0;
            if (pad.tightPitch) staggerToggle *= -1; else staggerToggle = 1;

            const dots = planPadDispense(pad, parseFloat(this.dispenseDegrees), sign);
            for (const {dx, dy, dispenseDegrees} of dots){
                this.placements.push(new Point(pad.x + dx, pad.y + dy, 31.5, dispenseDegrees));
            }
        }

        // Candidate fiducials: mask openings that don't correspond to a paste pad.
        const onlyInMask = maskFlashes.filter(mask =>
            !pastePads.some(pad => Math.abs(pad.x - mask.x) < 0.05 && Math.abs(pad.y - mask.y) < 0.05)
        );

        for(const maskData of onlyInMask){
            const newPoint = new Point(maskData.x, maskData.y, 31.5);
            this.fiducials.push(newPoint);
        }

        // Draw immediately so the imported board is visible right away, before
        // we even get to the (optional, and possibly interrupted) fiducial step.
        this.drawJobToCanvas();
        this.loadJobIntoPositionList();

        if (this.fiducials.length < 3) {
            // Clicking asks returnClosestFidFromClickCoordinates() to match a candidate
            // within a small pixel threshold - with fewer than 3 candidates on the board,
            // some of those clicks can never match anything, so the toast-driven flow
            // below would wait forever. Skip it without blocking the view of the board -
            // paste points are already imported and visible; fiducials can be added
            // manually with Capture New Position.
            console.warn(`Only found ${this.fiducials.length} fiducial candidate(s) on the mask layer (need 3). Add fiducials manually if needed.`);
            return {padCount: this.placements.length, fiducialCount: this.fiducials.length};
        }

        // set up event listener for first fid selection
        // which just puts the closest point object directly into this.toast.receivedInput

        // we need a named function for removing the event listener later

        function sendClickToToast(event){


            const rect = this.jobCanvas.getBoundingClientRect();

            const x = event.clientX - rect.left;
            const y = this.jobCanvas.height - (event.clientY - rect.top); // Flip Y coordinate

            // console.log("event.clientX: ", event.clientX)
            // console.log("event.clientY: ", event.clientY)

            // console.log("rect.left: ", rect.left)
            // console.log("rect.top: ", rect.top)

            // console.log("clicked coordinates: ", x, y)

            let closestClick = this.returnClosestFidFromClickCoordinates(x, y);

            if (closestClick !== null){
                this.toast.receivedInput = closestClick
                console.log("her'es the point: ", this.toast.receivedInput)

                const ctx = this.jobCanvas.getContext("2d");
                ctx.fillStyle = "green";
                ctx.fillRect(closestClick.canvasX - 4, this.jobCanvas.height - closestClick.canvasY - 4, 8, 8);

            }
            else {
                console.log("no matching click")
            }
        }

        console.log("setting event listener");

        // .bind() returns a new function each time it's called, so addEventListener
        // and removeEventListener must share this exact reference - passing
        // sendClickToToast.bind(this) again to removeEventListener would silently
        // fail to match, leaking this listener on the canvas forever and letting
        // stray clicks (long after fid selection is done) keep setting
        // this.toast.receivedInput out from under whatever toast shows up next.
        const boundSendClickToToast = sendClickToToast.bind(this);
        this.jobCanvas.addEventListener("click", boundSendClickToToast);

        // show the first toast asking them to click
        const fid1_object = await this.toast.show("Please click on FID1 in the display.");

        // show the second toast asking them to click
        const fid2_object = await this.toast.show("Please click on FID2 in the display.");

        // show the third toast asking them to click
        const fid3_object = await this.toast.show("Please click on FID3 in the display.");

        // cancel event listener for fid selection
        this.jobCanvas.removeEventListener('click', boundSendClickToToast)

        // delete all fids from this.fiducials other than the ones we just got
        this.fiducials = [fid1_object, fid2_object, fid3_object];

        console.log("fiducials: ", this.fiducials)
        console.log("placements: ", this.placements)

        //populate the position list
        this.loadJobIntoPositionList();
        // make some buttons red so that the user knows it's NOT ready to run a job yet

        this.drawJobToCanvas();

        return {padCount: this.placements.length, fiducialCount: this.fiducials.length};

    }

    async findBoardRoughPosition(){
        // request in toast to jog to fid1
        await this.toast.show("Please jog the camera to be centered on FID1.");

        // upon hitting continue, grab current position, save to fid1 searchXY
        const fid1Rough = await this.lumen.grabBoardPosition();

        console.log("fid1Rough: ", fid1Rough)

        this.fiducials[0].searchX = parseFloat(fid1Rough[0]);
        this.fiducials[0].searchY = parseFloat(fid1Rough[1]);

        // repeat for fid2 and fid3
        await this.toast.show("Please jog the camera to be centered on FID2.");
        const fid2Rough = await this.lumen.grabBoardPosition();
        this.fiducials[1].searchX = parseFloat(fid2Rough[0]);
        this.fiducials[1].searchY = parseFloat(fid2Rough[1]);

        await this.toast.show("Please jog the camera to be centered on FID3.");
        const fid3Rough = await this.lumen.grabBoardPosition();
        this.fiducials[2].searchX = parseFloat(fid3Rough[0]);
        this.fiducials[2].searchY = parseFloat(fid3Rough[1]);

        // ask to jog tip directly touching top surface
        await this.toast.show("Please jog the paste extruder tip to just barely touch the board.");

        // grab z pos and add .2 mm or something
        let zPos = await this.lumen.grabBoardPosition();

        await this.lumen.serial.send(["G0 Z31.5"]);

        zPos = parseFloat(zPos[2]) + 0.2;

        // save that position to every placement
        for(const placement of this.placements){
            placement.z = zPos
        }

        console.log(`this.fiducials: `, this.fiducials)

        this.transformPlacements([
            [this.fiducials[0].searchX, this.fiducials[0].searchY],
            [this.fiducials[1].searchX, this.fiducials[1].searchY],
            [this.fiducials[2].searchX, this.fiducials[2].searchY]
        ]);

        console.log(this.placements);

        this.loadJobIntoPositionList()

    }

    async performTipCalibration(){
        await this.toast.show("Please jog the camera to be centered on any fiducial.");

        // upon hitting continue, grab current position, save to fid1 searchXY
        const camPos = await this.lumen.grabBoardPosition();

        await this.lumen.serial.send(["G0 Z31.5"]);

        await this.lumen.serial.goToRelative(-45,63);

        await this.lumen.serial.send(["G0 Z46.5"]);

        await this.toast.show("Please jog the nozzle tip to be perfectly centered on and touching the fiducial.");

        const nozPos = await this.lumen.grabBoardPosition();

        await this.lumen.serial.send(["G0 Z31.5"]);

        this.lumen.tipXoffset = nozPos[0] - camPos[0];
        this.lumen.tipYoffset = nozPos[1] - camPos[1];

    }

    async performFiducialCalibration(){
        // lots of checks first
        if(this.fiducials.length !== 3){
            console.error("No fids in this job, cannot perform fiducial calibration.");
            return;
        }

        let fidActual = [];
        // go through and capture the actual positions of the fids
        // then we can perform the transformation

        for(let i = 0; i < this.fiducials.length; i++){
            const fid = this.fiducials[i];
            console.log(`Processing fiducial ${i + 1}:`, fid)
            console.log("jogging to fid: ", fid.searchX, fid.searchY)

            try {

                await this.lumen.serial.goTo(fid.searchX, fid.searchY);
                await new Promise(resolve => setTimeout(resolve, 1500));


                await this.lumen.jogToFiducial();
                await new Promise(resolve => setTimeout(resolve, 1500));

                await this.lumen.jogToFiducial();
                await new Promise(resolve => setTimeout(resolve, 1500));

                const fidReal = await this.lumen.grabBoardPosition();

                console.log(`Fiducial ${i + 1} final position:`, fidReal);
                fidActual.push([parseFloat(fidReal[0]), parseFloat(fidReal[1])])

                fid.calX = fidReal[0];
                fid.calY = fidReal[1];

            } catch (error) {
                console.error(`Error processing fiducial ${i + 1}:`, error);
                throw error;
            }
        }

        console.log("All fiducials processed, transforming placements...");
        this.transformPlacements(fidActual);

        console.log("fid cal complete: ", this.fiducials);

        this.loadJobIntoPositionList();


    }


    loadJobIntoPositionList(){
        // clear existing position elements
        const positionsList = document.querySelector('.positions-list');
        positionsList.innerHTML = '';

        // add new position elements
        for (let placement of this.placements) {
            this.createPositionElement(placement, false);
        }
        for (let fiducial of this.fiducials) {
            this.createPositionElement(fiducial, true);
        }
    }

    handleFiducialSelectionClick(event){
        const rect = this.jobCanvas.getBoundingClientRect();
        const clickX = (event.clientX - rect.left);
        const clickY = (event.clientY - rect.top);

        let closestPoint = this.returnClosestFidFromClickCoordinates(clickX, clickY);

        if (closestPoint) {
            ctx.beginPath();
            ctx.arc(closestPoint.canvasX, rect.height - closestPoint.canvasY, 6, 0, Math.PI * 2);
            ctx.fill();

            //store in buffer
            this.clickedFidBuffer.push(closestPoint);

            // Move to next fiducial or close modal
            currentFidIndex++;
            if (currentFidIndex < 3) {
                updateModalForFid();
            } else {
                // All fids captured, close modal
                modal.style.display = 'none';
                overlay.style.display = 'none';

                //moving clicked fids into this.fiducials
                this.fiducials = this.clickedFidBuffer;
                //wiping buffer
                this.clickedFidBuffer = [];

                console.log(this.fiducials);

                //removing event listener
                canvas.removeEventListener('click', this.handleFiducialSelectionClick)

            }
        }
    }

    async captureNewPosition() {
        console.log('Job capture method called');
        if (!this.lumen.serial) {
            console.error('Serial manager not set');
            return;
        }

        //TODO move almost all of this to lumen

        console.log('Serial manager is set, proceeding with capture');

        this.lumen.serial.clearInspectBuffer();
        console.log('Inspect buffer cleared');

        await this.lumen.serial.send(["G92"]);
        console.log('G92 command sent');

        const pattern = /X:(.*?) Y:(.*?) Z:(.*?) A:(.*?) B:(.*?) /;
        const re = new RegExp(pattern, 'i');

        console.log("Serial inspect buffer contents:", this.lumen.serial.inspectBuffer);

        for (var i = 0; i < this.lumen.serial.inspectBuffer.length; i++) {
            let currLine = this.lumen.serial.inspectBuffer[i];
            console.log('Checking line:', currLine);

            let result = re.test(currLine);
            console.log('Regex test result:', result);

            if(result) {
                const matches = re.exec(currLine);
                console.log('Position matches:', matches);
                this.addPoint(
                    parseFloat(matches[1]),
                    parseFloat(matches[2]),
                    parseFloat(matches[3])
                );
                console.log('Point added to job');

                this.loadJobIntoPositionList();
                return;
            }
        }
        console.log('No valid position found in inspect buffer');
    }

    addPoint(x, y, z) {
        let newPoint = new Point(x, y, z)
        this.placements.push(newPoint);
    }


    async importFromFile(file) {
        try {
            const jsonString = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (e) => resolve(e.target.result);
                reader.onerror = (error) => reject(error);
                reader.readAsText(file);
            });

            const data = JSON.parse(jsonString);

            this.placements = (data.placements || []).map(p => {
                const point = new Point(p.x, p.y, p.z, p.dispenseDegrees);
                point.calX = p.calX;
                point.calY = p.calY;
                point.canvasX = p.canvasX;
                point.canvasY = p.canvasY;
                return point;
            });
            this.fiducials = (data.fiducials || []).map(f => {
                const fid = new Fiducial(f.x, f.y, f.z, f.searchX, f.searchY);
                fid.calX = f.calX;
                fid.calY = f.calY;
                fid.canvasX = f.canvasX;
                fid.canvasY = f.canvasY;
                return fid;
            });

            this.dispenseDegrees = data.dispenseDegrees || 30;
            this.motionSpeed = data.motionSpeed || 35000;
            this.extruderSpeed = data.extruderSpeed || 100000;
            this.vacuumPressure = typeof data.vacuumPressure !== 'undefined' ? data.vacuumPressure : 100;
            this.preGcode = data.preGcode || "";
            this.postGcode = data.postGcode || "";
            this.invertDispense = data.invertDispense || false;

            // Set tip offsets if present
            if (typeof data.tipXoffset !== 'undefined') this.lumen.tipXoffset = data.tipXoffset;
            if (typeof data.tipYoffset !== 'undefined') this.lumen.tipYoffset = data.tipYoffset;
            if (typeof data.zOffset !== 'undefined') this.lumen.zOffset = data.zOffset;

            // ui update
            const jobDispenseDeg = document.getElementById('jobDispenseDeg');
            const jobMotionSpeed = document.getElementById('jobMotionSpeed');
            const jobExtruderSpeed = document.getElementById('jobExtruderSpeed');
            const jobVacuumPressure = document.getElementById('jobVacuumPressure');
            const jobVacuumPressureValue = document.getElementById('jobVacuumPressureValue');
            const jobPreGcode = document.getElementById('jobPreGcode');
            const jobPostGcode = document.getElementById('jobPostGcode');
            const jobInvertDispense = document.getElementById('jobInvertDispense');
            const xOffsetValue = document.getElementById('x-offset-value');
            const yOffsetValue = document.getElementById('y-offset-value');
            const zOffsetValue = document.getElementById('z-offset-value');

            if (jobDispenseDeg) jobDispenseDeg.value = this.dispenseDegrees;
            if (jobMotionSpeed) jobMotionSpeed.value = this.motionSpeed;
            if (jobExtruderSpeed) jobExtruderSpeed.value = this.extruderSpeed;
            if (jobVacuumPressure) jobVacuumPressure.value = this.vacuumPressure;
            if (jobVacuumPressureValue) jobVacuumPressureValue.textContent = this.vacuumPressure;
            if (jobPreGcode) jobPreGcode.value = this.preGcode;
            if (jobPostGcode) jobPostGcode.value = this.postGcode;
            if (jobInvertDispense) jobInvertDispense.checked = this.invertDispense;
            if (xOffsetValue) xOffsetValue.textContent = `${this.lumen.tipXoffset.toFixed(1)}mm`;
            if (yOffsetValue) yOffsetValue.textContent = `${this.lumen.tipYoffset.toFixed(1)}mm`;
            if (zOffsetValue) zOffsetValue.textContent = `${this.lumen.zOffset.toFixed(1)}mm`;

            // Update the UI position list
            this.loadJobIntoPositionList();

            this.drawJobToCanvas();

            return { success: true };
        } catch (error) {
            return { success: false, error: error.message || error.toString() };
        }
    }



    async saveToFile() {
        const jsonData = this.export();
        const blob = new Blob([jsonData], { type: 'application/json' });

        const handle = await window.showSaveFilePicker({
            suggestedName: 'job.json',
            types: [{
                description: 'JSON Files',
                accept: {
                    'application/json': ['.json']
                }
            }]
        });

        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
    }

    createPositionElement(position, isFiducial) {
        const positionsList = document.querySelector('.positions-list');
        const newDiv = document.createElement('div');
        newDiv.className = 'position-item';

        let writtenX, writtenY;

        if(position.calX != null & position.calY != null){
            writtenX = position.calX;
            writtenY = position.calY;
        }
        else if(position.searchX != null & position.searchY != null){
            writtenX = position.searchX;
            writtenY = position.searchY;
        }
        else{
            writtenX = position.x;
            writtenY = position.y;
        }

        if(isFiducial){
            newDiv.innerHTML = `
            <span class="position-text">Fiducial: X:${writtenX} Y:${writtenY} Z:${position.z}</span>
            <div class="button-group">
                <button class="move-btn">☉</button>
                <button class="remove-btn">X</button>
            </div>
        `;
        }
        else{
            newDiv.innerHTML = `
            <span class="position-text">Position: X:${writtenX} Y:${writtenY} Z:${position.z}</span>
            <div class="button-group">
                <button class="move-btn">☉</button>
                <button class="remove-btn">X</button>
            </div>
        `;
        }



        // Add click handler for Move To button
        newDiv.querySelector('.move-btn').addEventListener('click', () => {

            let writtenX, writtenY;

            if(position.calX != null & position.calY != null){
                writtenX = position.calX;
                writtenY = position.calY;
            }
            else{
                writtenX = position.x;
                writtenY = position.y;
            }

            this.lumen.serial.send([
                "G90",  // Set absolute positioning
                "G0 Z31.5",
                `G0 X${writtenX} Y${writtenY}`  // Move to position
            ]);
        });

        // Add click handler for Remove button
        newDiv.querySelector('.remove-btn').addEventListener('click', () => {
            newDiv.remove();

            this.placements = this.placements.filter(p =>
                p.x !== position.x || p.y !== position.y || p.z !== position.z
            );

            this.fiducials = this.fiducials.filter(p =>
                p.x !== position.x || p.y !== position.y || p.z !== position.z
            );

            this.loadJobIntoPositionList();
            this.drawJobToCanvas();

            console.log(this.placements)
        });

        positionsList.appendChild(newDiv);
    }

    //TODO reimplement this
    // async capturePosition() {

    //     await this.capture();

    //     const lastPoint = this.getPoint(this.getPointCount() - 1);
    //     console.log('Last captured point:', lastPoint);

    //     if (lastPoint) {

    //         this.createPositionElement([lastPoint.x, lastPoint.y, lastPoint.z]);
    //     }
    // }

    // generates array of commands to send
    // in format serial.send(commands)
    slice(){
        const commands = [];

        // add pre-gcode commands
        if (this.preGcode && this.preGcode.trim()) {
            const preCommands = this.preGcode.split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0);
            commands.push(...preCommands);
        }

        commands.push(
            "G90",          // set to absolute mode
            "G92 B0",        // reset b axis to 0
            "G0 Z31.5"      // make sure we're clear of the board
        );

        // Positive B extrudes on this auger; invert direction if invertDispense is enabled
        const dispenseSign = this.invertDispense ? -1 : 1;

        for(const point of this.placements) {

            let x = point.x;
            let y = point.y;

            if(point.calX != null){
                x = point.calX;
            }

            if(point.calY != null){
                y = point.calY;
            }

            const z = point.z + this.lumen.zOffset;

            // Gerber-imported points may carry their own pad-size-scaled dispense
            // amount; manually captured points fall back to the global setting.
            const dispenseDeg = point.dispenseDegrees != null ? point.dispenseDegrees : parseFloat(this.dispenseDegrees);

            commands.push(
                `G0 X${x + this.lumen.tipXoffset} Y${y + this.lumen.tipYoffset} F${this.motionSpeed}`, // Move over
                `G0 Z${z}`,                                    // Move z down
                "G91",                                         // Relative mode
                "M106 P2 S{VACUUM}",                            // Pump on (speed substituted live at send time)
                "G0 Z-.5",                                      // Come up .5mm
                "M906 B 1000",                                  // Extruder current high
                `G0 B${dispenseSign * dispenseDeg} F${this.extruderSpeed}`, // Extrude paste
                "G0 Z.3",                                       // Come down .3mm
            );

            // Wiggle the tip up/down to help release paste stuck to the nozzle
            for (let i = 0; i < 4; i++) {
                commands.push("G0 Z-.5", "G0 Z.3");
            }

            commands.push(
                "G90",                                 // Absolute mode
                `G0 Z31.5 F${this.motionSpeed}`,       // Move to safe Z
            );
        }

        commands.push(`G0 X5 Y5 F${this.motionSpeed}`);
        commands.push(`G0 F${this.motionSpeed}`);


        // add post-gcode commands
        if (this.postGcode && this.postGcode.trim()) {
            const postCommands = this.postGcode.split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0);
            commands.push(...postCommands);
        }

        return commands;

    }

    // Parks the head, kills both pumps, and drops the extruder current back down.
    // Shared by every way a job run can end (finished, cancelled via the toast) so
    // the board is always left in the same state instead of each path improvising.
    async finishRun(){
        this.isRunning = false;
        this.toast.receivedInput = false;
        this.toast.hide();

        await this.lumen.serial.send(["G90"]);
        await this.lumen.serial.send(["M906 B 200"]);
        await this.lumen.serial.send(["M107 P2"]);
        await this.lumen.serial.send(["M107 P3"]);
        await this.lumen.serial.send(["G0 Z31.5 F10000"]);
        await this.lumen.serial.send(["G0 X5 Y5"]);
        await this.lumen.serial.send(["G0 F35000"]);
    }

    // slices and executes a job
    async run(){

        let commands = this.slice()

        this.toast.show("Running job. Close this to cancel.");

        this.isRunning = true;

        for(const command of commands){

            console.log(this.toast.receivedInput)

            if(this.toast.toastObject.style.display == "none"){
                await this.finishRun();
                return;
            }

            // Substitute the current air assist level at send time so the slider
            // can retune the pump speed live while the job is running. Stored as
            // a 0-100 percentage; the firmware wants a 0-255 PWM value.
            const vacuumPwm = Math.round(this.vacuumPressure / 100 * 255);
            const resolvedCommand = command.replace("{VACUUM}", vacuumPwm);

            const sendOk = await this.lumen.serial.send([resolvedCommand]);

            // send() returns false (instead of throwing) when the port drops mid-job.
            // Stop here rather than blasting through the rest of the commands, which
            // would otherwise fire a "Cannot Write" prompt for every remaining line.
            // The board is already unreachable, so skip the parking gcode - it would
            // just fail the same way and spam another round of error modals.
            if (!sendOk) {
                console.warn("Job stopped: lost connection to the board.");
                this.isRunning = false;
                this.toast.receivedInput = false;
                this.toast.hide();
                return;
            }

        }

        await this.finishRun();

    }


    export() {
        const data = {
            placements: this.placements.map(p => ({
                x: p.x,
                y: p.y,
                z: p.z,
                dispenseDegrees: p.dispenseDegrees,
                calX: p.calX,
                calY: p.calY,
                canvasX: p.canvasX,
                canvasY: p.canvasY
            })),
            fiducials: this.fiducials.map(f => ({
                x: f.x,
                y: f.y,
                z: f.z,
                calX: f.calX,
                calY: f.calY,
                canvasX: f.canvasX,
                canvasY: f.canvasY,
                searchX: f.searchX,
                searchY: f.searchY
            })),
            dispenseDegrees: this.dispenseDegrees,
            motionSpeed: this.motionSpeed,
            extruderSpeed: this.extruderSpeed,
            vacuumPressure: this.vacuumPressure,
            preGcode: this.preGcode,
            postGcode: this.postGcode,
            invertDispense: this.invertDispense,
            tipXoffset: this.lumen.tipXoffset,
            tipYoffset: this.lumen.tipYoffset,
            zOffset: this.lumen.zOffset
        };
        return JSON.stringify(data, null, 2);
    }

    // performs a linear transformation on all placement points based on three fiducial points
    // realFids should be an array of three [x,y] coordinates representing where the fiducials actually are
    transformPlacements(realFids) {
        // Get the original fiducial positions from our job
        const origFids = [
            [this.fiducials[0].x, this.fiducials[0].y],
            [this.fiducials[1].x, this.fiducials[1].y],
            [this.fiducials[2].x, this.fiducials[2].y]
        ]

        const matrix = fromTriangles(origFids, realFids);

        for (let point of this.placements) {

            let transformedPoint = applyToPoint(matrix, [point.x, point.y])

            point.calX = transformedPoint[0];
            point.calY = transformedPoint[1];

        }

    }

}
