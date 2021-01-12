import React, { Component, createRef } from "react";
import { Viewer, CustomDataSource, CzmlDataSource } from "resium";

class SatelliteDataSource extends Component {
    constructor(props) {
        super(props);
    }

    componentDidMount() {
        if (this.viewer) {
            console.log('component mounted!');
            // this.viewer is Cesium's Viewer
            // DO SOMETHING
        }
    }

    render() {
        return (<CzmlDataSource />);
    }
}

export default SatelliteDataSource;